#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lattix relay — VPS diagnosis ("the website doesn't open").
#
# Read-only. Walks the request path from the outside in and stops guessing:
#   DNS (A + AAAA)  ->  firewall  ->  :80/:443 listener  ->  TLS certificate
#   ->  reverse proxy  ->  relay on 127.0.0.1  ->  web client files  ->  /ws
# and prints the first thing that is broken with the command that fixes it.
#
# Usage (on the VPS):
#   sudo bash /opt/lattix/app/deploy/vps/lattix-doctor.sh
#   sudo bash lattix-doctor.sh --domain chat.example.com   # override saved domain
#
# Works for installs made by install-debian.sh (Caddy or nginx). It also spots
# the common manual mistake of running `python run.py` and browsing to
# http://<vps-ip>:8000 — that can never work (see "secure context" below).
# ---------------------------------------------------------------------------
set -uo pipefail

CONF_DIR="/etc/lattix"
ENV_FILE="$CONF_DIR/lattix.env"
STATE_FILE="$CONF_DIR/install.conf"
APP_DIR="/opt/lattix/app"
DOMAIN=""
PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

c_b=$'\e[1m'; c_g=$'\e[32m'; c_y=$'\e[33m'; c_r=$'\e[31m'; c_d=$'\e[2m'; c_o=$'\e[0m'
FAILS=0; WARNS=0
declare -a FIXES=()
ok()   { printf '  %s✓%s %s\n' "$c_g" "$c_o" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$c_r" "$c_o" "$*"; FAILS=$((FAILS+1)); }
meh()  { printf '  %s!%s %s\n' "$c_y" "$c_o" "$*"; WARNS=$((WARNS+1)); }
info() { printf '    %s%s%s\n' "$c_d" "$*" "$c_o"; }
fix()  { FIXES+=("$*"); }
hdr()  { printf '\n%s%s%s\n' "$c_b" "$*" "$c_o"; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo) — some checks read root-only logs and sockets." >&2; exit 1; }

# ---------------------------------------------------------------- settings --
hdr "Settings"
if [[ -r "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  ok "Found $STATE_FILE"
else
  meh "No $STATE_FILE — install-debian.sh has not completed a full install on this machine."
fi
if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  ok "Found $ENV_FILE"
else
  meh "No $ENV_FILE"
fi
DOMAIN="${DOMAIN:-${SAVED_DOMAIN:-}}"
PORT="${PORT:-${LATTIX_PORT:-${SAVED_PORT:-8000}}}"
PROXY="${SAVED_PROXY:-}"
if [[ -z "$PROXY" ]]; then
  systemctl is-active --quiet caddy 2>/dev/null && PROXY=caddy
  systemctl is-active --quiet nginx 2>/dev/null && PROXY=nginx
fi
info "domain=${DOMAIN:-<unknown>}  relay port=$PORT  proxy=${PROXY:-<none running>}"
[[ -n "$DOMAIN" ]] || { bad "No domain known."; fix "Re-run with --domain, or install: sudo bash install-debian.sh --domain chat.example.com --email you@example.com"; }

for t in curl ss dig openssl; do
  have "$t" || { meh "'$t' not installed — some checks skipped"; fix "apt-get install -y curl iproute2 dnsutils openssl"; }
done

# ---------------------------------------------------- manual run.py mistakes --
hdr "How the relay is being run"
manual=$(pgrep -af 'run\.py|uvicorn server\.main' 2>/dev/null | grep -v lattix-doctor || true)
if systemctl list-unit-files lattix.service >/dev/null 2>&1 && systemctl cat lattix >/dev/null 2>&1; then
  ok "systemd unit lattix.service is installed"
else
  meh "No lattix.service — the relay isn't installed as a service."
fi
if [[ -n "$manual" ]]; then
  while read -r line; do
    info "process: $line"
    if [[ "$line" == *run.py* ]]; then
      if [[ "$line" == *0.0.0.0* || "$line" == *"--host ::"* ]]; then
        bad "run.py is bound to all interfaces and is being opened over plain http://<ip>:port."
        info "Browsers disable the Web Crypto API on http:// anywhere except localhost, so the page"
        info "loads but cannot create or unlock a vault. This is a browser rule, not a Lattix bug."
        fix "Use HTTPS: sudo bash $APP_DIR/deploy/vps/install-debian.sh --domain <name> --email <you> (then stop the manual run.py)"
        fix "Or test through an SSH tunnel from your PC: ssh -N -L 8000:127.0.0.1:8000 <user>@<vps> and open http://localhost:8000"
      else
        meh "run.py is running manually (bound to loopback). From outside it's only reachable through a proxy or SSH tunnel."
      fi
    fi
  done <<< "$manual"
fi

# ------------------------------------------------------------------ relay --
hdr "Relay (127.0.0.1:$PORT)"
if systemctl is-active --quiet lattix 2>/dev/null; then
  ok "lattix.service is active"
else
  bad "lattix.service is not running"
  journalctl -u lattix -n 25 --no-pager 2>/dev/null | sed 's/^/    /'
  fix "sudo systemctl restart lattix && journalctl -u lattix -n 50 --no-pager"
fi
health=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
if [[ -n "$health" ]]; then
  ok "Health: $health"
else
  bad "Nothing answers http://127.0.0.1:$PORT/api/health"
  holder=$(ss -H -ltnp "( sport = :$PORT )" 2>/dev/null | head -n1)
  [[ -n "$holder" ]] && info "port $PORT is held by: $holder"
  fix "journalctl -u lattix -n 80 --no-pager   # look for the Python traceback"
fi
root_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null || true)
root_code=${root_code:-000}
if [[ "$root_code" == "200" ]]; then
  ok "Web client served at / (HTTP 200)"
elif [[ "$root_code" == "503" ]]; then
  bad "Relay answers / with 503 — the web client (client/index.html) is missing, so it runs API-only."
  fix "Reinstall full code: sudo bash $APP_DIR/deploy/vps/install-debian.sh --update (never --source a partial 'changed-files' folder)"
elif [[ -n "$health" ]]; then
  bad "Relay answers / with HTTP $root_code"
fi
for f in client/index.html client/js/app.js client/vendor/lattix-pqc.js requirements.txt; do
  [[ -f "$APP_DIR/$f" ]] || { bad "Missing $APP_DIR/$f"; fix "sudo bash $APP_DIR/deploy/vps/install-debian.sh --update"; }
done
if [[ -n "${LATTIX_BIND:-}" && "$LATTIX_BIND" != "127.0.0.1" ]]; then
  meh "LATTIX_BIND=$LATTIX_BIND — the relay should listen on 127.0.0.1 behind the proxy."
fi

# ------------------------------------------------------------------ proxy --
hdr "Reverse proxy (${PROXY:-none})"
case "$PROXY" in
  caddy)
    if systemctl is-active --quiet caddy; then ok "caddy is active"; else
      bad "caddy is not running"; journalctl -u caddy -n 20 --no-pager | sed 's/^/    /'
      fix "sudo systemctl restart caddy && journalctl -u caddy -n 80 --no-pager"; fi
    if caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      ok "/etc/caddy/Caddyfile is valid"
    else
      bad "/etc/caddy/Caddyfile does not validate"
      caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile 2>&1 | tail -n 5 | sed 's/^/    /'
      fix "sudo bash $APP_DIR/deploy/vps/install-debian.sh --update   # re-renders the Caddyfile"
    fi
    if [[ -n "$DOMAIN" ]] && ! grep -q "^$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
      bad "/etc/caddy/Caddyfile has no site block for $DOMAIN"
      fix "sudo bash $APP_DIR/deploy/vps/install-debian.sh --domain $DOMAIN --email <you>"
    fi
    acme=$(journalctl -u caddy --since "-2h" --no-pager 2>/dev/null \
           | grep -Ei 'could not get certificate|challenge failed|acme.*error|obtaining certificate.*error|rateLimited|NXDOMAIN|Timeout during connect' \
           | tail -n 4)
    if [[ -n "$acme" ]]; then
      bad "Caddy reports certificate (ACME) errors in the last 2 hours:"
      sed 's/^/    /' <<< "$acme" | cut -c1-300
      fix "Certificate issuance is failing — fix the DNS / firewall items flagged below, then: sudo systemctl restart caddy"
    fi
    ;;
  nginx)
    if systemctl is-active --quiet nginx; then ok "nginx is active"; else
      bad "nginx is not running"; fix "sudo nginx -t && sudo systemctl restart nginx"; fi
    if nginx -t >/dev/null 2>&1; then ok "nginx -t passes"; else
      bad "nginx -t fails"; nginx -t 2>&1 | tail -n 5 | sed 's/^/    /'; fi
    if [[ -n "$DOMAIN" && ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
      bad "No Let's Encrypt certificate for $DOMAIN"
      fix "sudo bash $APP_DIR/deploy/vps/install-debian.sh --proxy nginx --domain $DOMAIN --email <you>"
    fi
    ;;
  *)
    bad "Neither caddy nor nginx is running — nothing serves ports 80/443."
    fix "sudo bash $APP_DIR/deploy/vps/install-debian.sh --domain <name> --email <you>"
    ;;
esac
if systemctl is-active --quiet apache2 2>/dev/null; then
  bad "apache2 is running — it competes for ports 80/443."
  fix "sudo systemctl disable --now apache2 && sudo systemctl restart ${PROXY:-caddy}"
fi

# -------------------------------------------------------------- listeners --
hdr "Listening sockets"
for p in 80 443; do
  l=$(ss -H -ltnp "( sport = :$p )" 2>/dev/null)
  if [[ -z "$l" ]]; then
    bad "Nothing is listening on TCP $p"
    fix "sudo systemctl restart ${PROXY:-caddy} && journalctl -u ${PROXY:-caddy} -n 50 --no-pager"
  else
    who=$(grep -o 'users:(("[^"]*"' <<< "$l" | cut -d'"' -f2 | sort -u | tr '\n' ' ')
    ok "TCP $p <- ${who:-?}"
    [[ -n "$PROXY" && "$who" != *"$PROXY"* ]] && { bad "Port $p is held by '$who', not $PROXY"; fix "Stop '$who' (systemctl disable --now <it>) and restart $PROXY"; }
  fi
done
pub=$(ss -H -ltn "( sport = :$PORT )" 2>/dev/null | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):' || true)
[[ -n "$pub" ]] && meh "Relay port $PORT is listening publicly ($pub). Browsing to it over http:// cannot work; use https://$DOMAIN."

# --------------------------------------------------------------- firewall --
hdr "Host firewall"
if have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then
  st=$(ufw status)
  for p in 80 443; do
    if grep -Eq "^$p(/tcp)?[[:space:]].*ALLOW" <<< "$st"; then ok "ufw allows $p/tcp"
    else bad "ufw is active but does not allow $p/tcp"; fix "sudo ufw allow $p/tcp"; fi
  done
else
  info "ufw inactive or absent"
fi
if have nft && nft list ruleset 2>/dev/null | grep -Eq 'policy drop|policy reject'; then
  info "nftables has a drop/reject policy — make sure 80 and 443 are accepted there too."
fi
info "OVHcloud: if the 'Edge Network Firewall' is enabled for this IP in the control panel,"
info "it must also allow TCP 80 and 443 (it filters before traffic reaches the VPS)."

# -------------------------------------------------------------------- DNS --
if [[ -n "$DOMAIN" ]] && have dig; then
  hdr "DNS for $DOMAIN"
  ip4=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  ip6=$(curl -6 -fsS --max-time 5 https://api64.ipify.org 2>/dev/null || true)
  info "this VPS: IPv4=${ip4:-?}  IPv6=${ip6:-none}"
  a=$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | sort -u)
  aaaa=$(dig +short AAAA "$DOMAIN" @1.1.1.1 2>/dev/null | grep ':' | sort -u)
  if [[ -z "$a" ]]; then
    bad "$DOMAIN has no A record"
    fix "Create DNS record: $DOMAIN  A  ${ip4:-<vps ipv4>}"
  elif [[ -n "$ip4" ]] && ! grep -qx "$ip4" <<< "$a"; then
    bad "$DOMAIN A -> $(tr '\n' ' ' <<< "$a")but this VPS is $ip4"
    fix "Change the A record of $DOMAIN to $ip4 (and remove any other A records)"
  else
    ok "A $DOMAIN -> $(tr '\n' ' ' <<< "$a")"
  fi
  [[ $(wc -l <<< "$a") -gt 1 ]] && { meh "Multiple A records — visitors get sent to the wrong host some of the time."; fix "Keep only one A record for $DOMAIN"; }
  if [[ -n "$aaaa" ]]; then
    if [[ -z "$ip6" ]]; then
      bad "$DOMAIN has AAAA $(tr '\n' ' ' <<< "$aaaa")but this VPS has no working IPv6."
      info "Let's Encrypt validates over IPv6 first, and IPv6 visitors get nowhere. OVHcloud's"
      info "default DNS zone often contains AAAA records pointing at its web-hosting cluster."
      fix "Delete the AAAA record for $DOMAIN (or configure the VPS's IPv6), then: sudo systemctl restart ${PROXY:-caddy}"
    elif ! grep -qix "$ip6" <<< "$aaaa"; then
      bad "$DOMAIN AAAA -> $(tr '\n' ' ' <<< "$aaaa")but this VPS is $ip6"
      fix "Change/delete the AAAA record for $DOMAIN (VPS IPv6: $ip6)"
    else
      ok "AAAA $DOMAIN -> $aaaa"
    fi
  else
    info "no AAAA record (fine)"
  fi
  caa=$(dig +short CAA "$(awk -F. '{print $(NF-1)"."$NF}' <<< "$DOMAIN")" @1.1.1.1 2>/dev/null)
  if [[ -n "$caa" ]] && ! grep -qi 'letsencrypt' <<< "$caa"; then
    bad "A CAA record forbids Let's Encrypt: $caa"
    fix "Add CAA: 0 issue \"letsencrypt.org\" (or remove the CAA record)"
  fi
fi

# ------------------------------------------------------- HTTPS end to end --
if [[ -n "$DOMAIN" ]]; then
  hdr "HTTPS"
  # 1) Straight into the local proxy, skipping DNS and outside firewalls.
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || true); code=${code:-000}
  if [[ "$code" == "200" ]]; then ok "Local proxy -> relay works (https://$DOMAIN via 127.0.0.1)"
  else bad "Local proxy test gave HTTP $code (000 = no TLS listener / handshake failed)"; fi
  # 2) Certificate actually presented.
  if have openssl; then
    cert=$(echo | timeout 8 openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null \
           | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null)
    if [[ -z "$cert" ]]; then
      bad "No certificate presented for $DOMAIN on :443 — issuance hasn't succeeded."
      fix "Fix DNS/firewall above, then: sudo systemctl restart ${PROXY:-caddy} and watch: journalctl -u ${PROXY:-caddy} -f"
    else
      grep -qi 'staging\|fake' <<< "$cert" && { bad "Certificate is from Let's Encrypt STAGING (browsers reject it)"; }
      grep -qi 'Caddy Local Authority' <<< "$cert" && { bad "Certificate is Caddy's internal CA (browsers reject it) — public issuance failed"; }
      ok "Certificate: $(tr '\n' ' ' <<< "$cert" | cut -c1-220)"
    fi
  fi
  # 3) The real public path, with certificate verification, as a browser would.
  if out=$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>&1); then
    ok "Public https://$DOMAIN/api/health: $out"
  else
    bad "Public https://$DOMAIN fails: $(tail -n1 <<< "$out")"
    info "If the local test passed but this fails: DNS, the OVH Edge firewall, or IPv6 (AAAA) is the cause."
  fi
  # 4) WebSocket upgrade through the proxy (HTTP/1.1).
  ws=$(curl -sk --http1.1 -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "https://$DOMAIN/ws" 2>/dev/null || true)
  case "$ws" in
    101*) ok "WebSocket upgrade on /ws works (101)";;
    *)    bad "WebSocket upgrade on /ws returned '${ws:-nothing}' (expected 101) — messages won't arrive live";
          fix "Check the proxy's /ws block (nginx needs Upgrade/Connection headers; Caddy handles it automatically)";;
  esac
fi

# ---------------------------------------------------------------- summary --
hdr "Summary"
if [[ $FAILS -eq 0 ]]; then
  printf '  %sNo blocking problems found%s (%d warning(s)).\n' "$c_g" "$c_o" "$WARNS"
  [[ -n "$DOMAIN" ]] && echo "  Open https://$DOMAIN — not http://, and not the IP address or :$PORT."
  echo "  If a browser still fails, try a private window (an old HSTS/cached redirect) and check its console."
else
  printf '  %s%d problem(s)%s, %d warning(s). Fix in this order:\n' "$c_r" "$FAILS" "$c_o" "$WARNS"
  declare -A seen=()
  n=1
  for f in "${FIXES[@]}"; do
    [[ -n "${seen[$f]:-}" ]] && continue
    seen[$f]=1
    printf '   %d. %s\n' "$n" "$f"; n=$((n+1))
  done
fi
exit $(( FAILS > 0 ))
