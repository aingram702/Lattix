#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lattix relay — one-shot installer for a Debian VPS (OVHcloud or any other).
#
# Installs the relay as a hardened systemd service bound to 127.0.0.1, puts
# Caddy (default) or nginx + certbot in front of it with Let's Encrypt HTTPS,
# and opens only SSH/80/443 in the firewall.
#
# Before running:
#   1. Create a DNS A record (and AAAA if the VPS has IPv6) for your domain
#      pointing at the VPS, e.g.  chat.example.com -> 51.x.x.x
#   2. If you enabled the OVHcloud "Network Firewall" for the IP in the control
#      panel, allow TCP 80 and 443 there too.
#
# Usage (as root, or with sudo):
#   sudo bash install-debian.sh --domain chat.example.com --email you@example.com
#   sudo bash install-debian.sh --domain chat.example.com --email you@example.com --proxy nginx
#
# Re-running is safe: it updates the code, keeps the database and settings,
# and restarts the relay. Update later with:
#   sudo bash /opt/lattix/app/deploy/vps/install-debian.sh --update
#
# Options:
#   --domain NAME        public host name for the relay (required on first install)
#   --email ADDR         Let's Encrypt contact email (required on first install)
#   --proxy caddy|nginx  reverse proxy to install (default: caddy)
#   --max-file-mb N      largest encrypted upload in MB (default: 50)
#   --repo URL           git repository to install from
#                        (default: https://github.com/aingram702/Lattix.git)
#   --branch NAME        git branch or tag (default: main)
#   --source DIR         install from a local checkout instead of git
#   --port N             loopback port for the relay (default: 8000)
#   --no-firewall        don't configure ufw
#   --update             only update code + dependencies and restart
#   -h, --help           show this help
# ---------------------------------------------------------------------------
set -Eeuo pipefail

REPO_URL="https://github.com/aingram702/Lattix.git"
BRANCH="main"
DOMAIN=""
EMAIL=""
PROXY="caddy"
MAX_FILE_MB="50"
SOURCE_DIR=""
PORT="8000"
FIREWALL=1
UPDATE_ONLY=0
MAX_FILE_MB_SET=0

APP_ROOT="/opt/lattix"
APP_DIR="$APP_ROOT/app"
VENV="$APP_ROOT/venv"
DATA_DIR="/var/lib/lattix"
CONF_DIR="/etc/lattix"
ENV_FILE="$CONF_DIR/lattix.env"
STATE_FILE="$CONF_DIR/install.conf"
SERVICE_USER="lattix"

c_bold=$'\e[1m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_off=$'\e[0m'
log()  { printf '%s==>%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s!!%s  %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%sxx%s  %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
trap 'die "Failed at line $LINENO: $BASH_COMMAND"' ERR

usage() { sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="${2:-}"; shift 2 ;;
    --email)        EMAIL="${2:-}"; shift 2 ;;
    --proxy)        PROXY="${2:-}"; shift 2 ;;
    --max-file-mb)  MAX_FILE_MB="${2:-}"; MAX_FILE_MB_SET=1; shift 2 ;;
    --repo)         REPO_URL="${2:-}"; shift 2 ;;
    --branch)       BRANCH="${2:-}"; shift 2 ;;
    --source)       SOURCE_DIR="${2:-}"; shift 2 ;;
    --port)         PORT="${2:-}"; shift 2 ;;
    --no-firewall)  FIREWALL=0; shift ;;
    --update)       UPDATE_ONLY=1; shift ;;
    -h|--help)      usage ;;
    *)              die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0 $*"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" || "${ID_LIKE:-}" == *debian* ]] \
  || warn "This script targets Debian; detected '${PRETTY_NAME:-unknown}'. Continuing anyway."

# Previous install settings fill in anything not given on the command line.
if [[ -r "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  DOMAIN="${DOMAIN:-${SAVED_DOMAIN:-}}"
  EMAIL="${EMAIL:-${SAVED_EMAIL:-}}"
  [[ "$PROXY" == "caddy" && -n "${SAVED_PROXY:-}" ]] && PROXY="$SAVED_PROXY"
  [[ -z "$SOURCE_DIR" && "$REPO_URL" == "https://github.com/aingram702/Lattix.git" && -n "${SAVED_REPO:-}" ]] && REPO_URL="$SAVED_REPO"
  [[ "$BRANCH" == "main" && -n "${SAVED_BRANCH:-}" ]] && BRANCH="$SAVED_BRANCH"
  [[ "$PORT" == "8000" && -n "${SAVED_PORT:-}" ]] && PORT="$SAVED_PORT"
fi

[[ "$PROXY" == "caddy" || "$PROXY" == "nginx" ]] || die "--proxy must be caddy or nginx"
[[ "$MAX_FILE_MB" =~ ^[0-9]+$ && "$MAX_FILE_MB" -ge 1 ]] || die "--max-file-mb must be a positive integer"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
if [[ $UPDATE_ONLY -eq 0 ]]; then
  [[ -n "$DOMAIN" ]] || die "--domain is required (e.g. --domain chat.example.com)"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
    || die "--domain '$DOMAIN' isn't a valid host name"
  [[ -n "$EMAIL" && "$EMAIL" == *@*.* ]] || die "--email is required for Let's Encrypt (e.g. --email you@example.com)"
fi
# Without --max-file-mb, keep whatever limit an earlier install configured.
if [[ $MAX_FILE_MB_SET -eq 0 && -r "$ENV_FILE" ]]; then
  existing=$(sed -n 's/^LATTIX_MAX_FILE_MB=\([0-9][0-9]*\)$/\1/p' "$ENV_FILE" | tail -n1)
  [[ -n "$existing" ]] && MAX_FILE_MB="$existing"
fi
# Upload ceiling at the proxy: the relay's limit plus multipart overhead.
MAX_BODY_MB=$(( MAX_FILE_MB + MAX_FILE_MB / 10 + 2 ))

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
install_base_packages() {
  log "Installing base packages"
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    ca-certificates curl git python3 python3-venv python3-pip rsync dnsutils \
    debian-keyring debian-archive-keyring apt-transport-https gnupg
}

create_user_and_dirs() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating system user '$SERVICE_USER'"
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0755 "$APP_ROOT"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
}

fetch_code() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -f "$SOURCE_DIR/server/main.py" ]] || die "--source $SOURCE_DIR doesn't look like a Lattix checkout"
    log "Copying code from $SOURCE_DIR"
    install -d "$APP_DIR"
    rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude 'data' \
      --exclude '__pycache__' "$SOURCE_DIR"/ "$APP_DIR"/
  elif [[ -d "$APP_DIR/.git" ]]; then
    log "Updating code ($BRANCH)"
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard FETCH_HEAD
  else
    log "Cloning $REPO_URL ($BRANCH)"
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  [[ -f "$APP_DIR/server/main.py" ]] || die "No server/main.py in $APP_DIR — wrong repository or branch?"
  chown -R root:root "$APP_DIR"
  chmod -R go-w "$APP_DIR"
}

install_python_env() {
  log "Installing Python dependencies"
  [[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$APP_DIR/requirements.txt"
}

write_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Keeping existing $ENV_FILE"
    # Keep the proxy limit in step if --max-file-mb changed it.
    sed -i "s/^LATTIX_MAX_FILE_MB=.*/LATTIX_MAX_FILE_MB=$MAX_FILE_MB/" "$ENV_FILE"
    grep -q '^LATTIX_KEEPALIVE=' "$ENV_FILE" || echo 'LATTIX_KEEPALIVE=75' >> "$ENV_FILE"
    return
  fi
  log "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Lattix relay settings. After editing:  sudo systemctl restart lattix

# SQLite database — accounts, public keys, ciphertext and encrypted file blobs.
LATTIX_DB=$DATA_DIR/lattix.db

# Largest encrypted upload, in MB. If you raise it, also raise the proxy limit
# (request_body max_size in /etc/caddy/Caddyfile, or client_max_body_size in
# /etc/nginx/sites-available/lattix.conf) — or just re-run the installer with
# --max-file-mb.
LATTIX_MAX_FILE_MB=$MAX_FILE_MB

# Loopback only: the reverse proxy is the sole way in.
LATTIX_BIND=127.0.0.1
LATTIX_PORT=$PORT

# Trust X-Forwarded-For only from the local proxy, so per-IP rate limiting sees
# real client addresses and nobody can spoof them.
LATTIX_FORWARDED_ALLOW_IPS=127.0.0.1

# Idle keep-alive (seconds) — longer than the proxy's upstream keep-alive (60s).
LATTIX_KEEPALIVE=75

# Interactive API docs at /api/docs are off on a public relay.
LATTIX_DOCS_URL=

# Desktop apps (http://localhost:8000) and the Chrome extension may connect by
# default. Add other web origins here if you host the client elsewhere, e.g.
# LATTIX_CORS_ORIGINS=https://lattix.example.org
LATTIX_CORS_ORIGINS=
LATTIX_CORS_ALLOW_LOCAL=1
EOF
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
}

install_service() {
  log "Installing systemd service"
  install -m 0644 "$APP_DIR/deploy/vps/lattix.service" /etc/systemd/system/lattix.service
  systemctl daemon-reload
  systemctl enable lattix >/dev/null 2>&1
  systemctl restart lattix
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      log "Relay is up on 127.0.0.1:$PORT"
      return
    fi
    sleep 0.5
  done
  journalctl -u lattix -n 40 --no-pager >&2 || true
  die "The relay didn't start — see the log above."
}

render_template() {  # $1 template  $2 destination  $3 size suffix (Caddy "MB", nginx "m")
  sed -e "s|__DOMAIN__|$DOMAIN|g" \
      -e "s|__EMAIL__|$EMAIL|g" \
      -e "s|__UPSTREAM__|127.0.0.1:$PORT|g" \
      -e "s|__MAX_BODY__|${MAX_BODY_MB}$3|g" \
      "$1" > "$2"
}

check_dns() {
  local public_ip resolved
  public_ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  resolved=$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | tail -n1 || true)
  if [[ -z "$resolved" ]]; then
    warn "$DOMAIN has no A record yet. HTTPS certificates can't be issued until DNS points at this VPS${public_ip:+ ($public_ip)}."
  elif [[ -n "$public_ip" && "$resolved" != "$public_ip" ]]; then
    warn "$DOMAIN resolves to $resolved, but this VPS's public IPv4 is $public_ip. Certificate issuance will fail until DNS is fixed."
  else
    log "DNS OK: $DOMAIN -> $resolved"
  fi
}

install_caddy() {
  if ! command -v caddy >/dev/null 2>&1; then
    log "Installing Caddy (official repository)"
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
  if systemctl is-active --quiet nginx 2>/dev/null; then
    warn "nginx is running and holds ports 80/443 — stopping and disabling it for Caddy."
    systemctl disable --now nginx || true
  fi
  install -d -o caddy -g caddy /var/log/caddy
  local tmp; tmp=$(mktemp)
  render_template "$APP_DIR/deploy/vps/Caddyfile.template" "$tmp" MB
  caddy fmt --overwrite "$tmp" >/dev/null 2>&1 || true
  caddy validate --adapter caddyfile --config "$tmp" >/dev/null || die "Generated Caddyfile is invalid ($tmp)"
  [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  install -m 0644 "$tmp" /etc/caddy/Caddyfile
  rm -f "$tmp"
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  log "Caddy configured for https://$DOMAIN"
}

install_nginx() {
  log "Installing nginx and certbot"
  apt-get install -y -q nginx certbot
  if systemctl is-active --quiet caddy 2>/dev/null; then
    warn "Caddy is running and holds ports 80/443 — stopping and disabling it for nginx."
    systemctl disable --now caddy || true
  fi
  rm -f /etc/nginx/sites-enabled/default
  install -d -m 0755 /var/www/lattix-acme

  local cert="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  if [[ ! -f "$cert" ]]; then
    # Serve only the ACME challenge over HTTP until a certificate exists.
    cat > /etc/nginx/sites-available/lattix.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/lattix-acme; }
    location / { return 503; }
}
EOF
    ln -sf /etc/nginx/sites-available/lattix.conf /etc/nginx/sites-enabled/lattix.conf
    nginx -t
    systemctl enable nginx >/dev/null 2>&1
    systemctl restart nginx
    log "Requesting a Let's Encrypt certificate for $DOMAIN"
    certbot certonly --webroot -w /var/www/lattix-acme -d "$DOMAIN" \
      --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
      || die "certbot couldn't issue a certificate. Check that $DOMAIN points at this VPS and port 80 is open, then re-run."
  fi

  render_template "$APP_DIR/deploy/vps/nginx-lattix.conf.template" /etc/nginx/sites-available/lattix.conf m
  ln -sf /etc/nginx/sites-available/lattix.conf /etc/nginx/sites-enabled/lattix.conf
  nginx -t
  systemctl enable nginx >/dev/null 2>&1
  systemctl reload nginx

  # Renewals keep using the webroot; reload nginx to pick up the new cert.
  install -d /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  log "nginx configured for https://$DOMAIN"
}

configure_firewall() {
  [[ $FIREWALL -eq 1 ]] || { warn "Skipping firewall (--no-firewall)"; return; }
  log "Configuring ufw (SSH, 80, 443)"
  apt-get install -y -q ufw
  # Detect the SSH port so enabling the firewall can't lock us out.
  local ssh_ports
  ssh_ports=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u || true)
  [[ -n "$ssh_ports" ]] || ssh_ports=22
  for p in $ssh_ports; do ufw allow "$p/tcp" comment 'SSH' >/dev/null; done
  ufw allow 80/tcp  comment 'HTTP (ACME + redirect)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  [[ "$PROXY" == "caddy" ]] && ufw allow 443/udp comment 'HTTP/3' >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  # Belt and braces: the relay port must never be public.
  ufw deny "$PORT/tcp" >/dev/null || true
}

save_state() {
  cat > "$STATE_FILE" <<EOF
SAVED_DOMAIN='$DOMAIN'
SAVED_EMAIL='$EMAIL'
SAVED_PROXY='$PROXY'
SAVED_REPO='$REPO_URL'
SAVED_BRANCH='$BRANCH'
SAVED_PORT='$PORT'
EOF
  chmod 0640 "$STATE_FILE"
}

verify_public() {
  log "Checking https://$DOMAIN/api/health"
  for _ in $(seq 1 30); do
    if out=$(curl -fsS --max-time 5 "https://$DOMAIN/api/health" 2>/dev/null); then
      log "Public health check OK: $out"
      return 0
    fi
    sleep 2
  done
  warn "https://$DOMAIN isn't answering yet. Usually DNS or the certificate is still pending; check:"
  warn "  journalctl -u $PROXY -n 50 --no-pager"
  return 0
}

# ---------------------------------------------------------------------------
if [[ $UPDATE_ONLY -eq 1 ]]; then
  [[ -d "$APP_DIR" ]] || die "Nothing to update — run a full install first."
  fetch_code
  install_python_env
  write_env_file
  install_service
  if [[ -n "$DOMAIN" && -n "$EMAIL" ]]; then
    if [[ "$PROXY" == "caddy" ]]; then install_caddy; else install_nginx; fi
  fi
  log "Updated. Connected clients reconnect and sign back in automatically."
  exit 0
fi

install_base_packages
create_user_and_dirs
fetch_code
install_python_env
write_env_file
install_service
check_dns
if [[ "$PROXY" == "caddy" ]]; then install_caddy; else install_nginx; fi
configure_firewall
save_state
verify_public

cat <<EOF

${c_bold}Lattix relay is installed.${c_off}

  Web app:          https://$DOMAIN
  Health:           https://$DOMAIN/api/health
  Service:          systemctl status lattix     (logs: journalctl -u lattix -f)
  Settings:         $ENV_FILE
  Database:         $DATA_DIR/lattix.db         (back this up)
  Reverse proxy:    $PROXY

Connect the desktop apps or the Chrome extension:
  sign-in screen → "Relay: … Change" (or Settings → Relay server → Change…)
  → enter https://$DOMAIN → Test connection → Save & connect

Update later:
  sudo bash $APP_DIR/deploy/vps/install-debian.sh --update
EOF
