# Lattix relay on a Debian VPS (OVHcloud)

A native install without Docker: the relay runs as a hardened **systemd**
service bound to `127.0.0.1`, and **Caddy** (default) or **nginx + certbot**
terminates HTTPS in front of it. Tested against Debian 12 and 13 — including
OVHcloud's VPS images, where you log in as `debian` and use `sudo`.

| File | What it is |
|------|-----------|
| `install-debian.sh` | One-shot installer / updater (idempotent). |
| `lattix.service` | systemd unit: one worker, loopback only, sandboxed. |
| `Caddyfile.template` | Caddy site: auto-HTTPS, WebSocket-safe reloads, retries during restarts, token-free logs. |
| `nginx-lattix.conf.template` | nginx site: WebSocket upgrade, upstream keep-alive, timeouts, body size, token-free logs. |

## 1. Before you start

1. **DNS.** Create an `A` record for your relay name — e.g. `chat.example.com` —
   pointing at the VPS's IPv4 address (shown in the OVHcloud control panel). Add an
   `AAAA` record too if the VPS has IPv6 configured. Wait until
   `dig +short chat.example.com` returns the VPS address.
2. **OVHcloud Network Firewall.** Off by default. If you enabled it for this IP
   (*Bare Metal Cloud → IP → … → Configure the Network Firewall*), add rules
   allowing **TCP 80** and **TCP 443** (and UDP 443 for HTTP/3), above the final
   deny rule. The installer configures `ufw` on the VPS itself.
3. **SSH in** and get the repository:

   ```bash
   ssh debian@YOUR_VPS_IP
   sudo apt-get update && sudo apt-get install -y git
   git clone https://github.com/aingram702/Lattix.git
   cd Lattix
   ```

## 2. Install

```bash
# Caddy (recommended — simplest, automatic certificates)
sudo bash deploy/vps/install-debian.sh \
  --domain chat.example.com --email you@example.com --source "$PWD"

# …or nginx + certbot
sudo bash deploy/vps/install-debian.sh \
  --domain chat.example.com --email you@example.com --proxy nginx --source "$PWD"
```

`--source "$PWD"` installs the checkout you just cloned (handy for a branch you're
testing). Leave it out and the script clones `main` from GitHub itself.

What it does, in order:

1. Installs Python, git and friends; creates the `lattix` system user.
2. Puts the code in `/opt/lattix/app` and a virtualenv in `/opt/lattix/venv`.
3. Writes settings to `/etc/lattix/lattix.env` (kept on re-runs).
4. Installs and starts `lattix.service` on `127.0.0.1:8000`.
5. Checks your DNS, then installs and configures Caddy — or nginx and a
   Let's Encrypt certificate via certbot (auto-renewed, nginx reloaded on renewal).
6. Enables `ufw` allowing only your SSH port, 80 and 443.
7. Calls `https://chat.example.com/api/health` to confirm it's live.

Options: `--max-file-mb N` (upload limit, default 50 — the proxy limit is set to
match), `--port N`, `--branch NAME`, `--repo URL`, `--no-firewall`. See `--help`.

## 3. Connect your apps

- **Web:** open `https://chat.example.com` — that's it.
- **Desktop apps (Windows / macOS / Linux) and the Chrome extension:** on the
  sign-in screen, click **Change** next to *Relay: …* (or, once signed in,
  **Settings → Relay server → Change…**), enter `https://chat.example.com`,
  press **Test connection**, then **Save & connect**.

  The test checks that the relay answers, that it really is a Lattix relay, and
  that WebSocket upgrades make it through the proxy.

If you already had an account on the desktop app's built-in relay, unlock as
usual after switching — Lattix notices the new relay doesn't know your identity
and offers to **register the same identity** there. Your keys and safety code
don't change; conversations from the old relay don't move with you, and your
contacts need to use the same relay.

## 4. Day-to-day

```bash
systemctl status lattix              # is it running?
journalctl -u lattix -f              # relay log
journalctl -u caddy -f               # or: tail -f /var/log/nginx/lattix.error.log
sudo nano /etc/lattix/lattix.env     # settings, then:
sudo systemctl restart lattix

# Update to the latest main (keeps database and settings)
sudo bash /opt/lattix/app/deploy/vps/install-debian.sh --update
```

Restarting or updating the relay clears its in-memory sessions. Connected clients
notice, sign back in with the identity they already have unlocked, reconnect,
and fetch anything sent in the meantime — nobody has to re-enter a password.

**Back up** `/var/lib/lattix/lattix.db` (accounts, public keys, ciphertext and
encrypted files). A consistent copy while running:

```bash
sudo -u lattix sqlite3 /var/lib/lattix/lattix.db ".backup '/var/lib/lattix/backup-$(date +%F).db'"
```

(`sudo apt-get install -y sqlite3` first.)

## Why the proxy configs look the way they do

| Setting | Why |
|---------|-----|
| Relay bound to `127.0.0.1`, `--forwarded-allow-ips 127.0.0.1` | Only the proxy can reach it, so `X-Forwarded-For` is trustworthy and per-IP rate limiting sees real users. |
| `--timeout-keep-alive 75` vs proxy keep-alive `60s` | The proxy always retires an idle pooled connection before the relay closes it — otherwise the race shows up as random 502s. |
| One worker | Sessions, sockets and rate limits live in memory. |
| Caddy `lb_try_duration 10s` | During a relay restart requests wait and retry the connection instead of failing with 502. Only failed connects are retried, so a message is never sent twice. |
| Caddy `stream_close_delay 5m`, `grace_period` | `systemctl reload caddy` doesn't drop every open WebSocket. |
| nginx `proxy_read_timeout 3600s` on `/ws` | The default 60s would cut idle sockets; clients ping every 25s anyway. |
| `request_body max_size` / `client_max_body_size` a bit above `LATTIX_MAX_FILE_MB` | The relay, not the proxy, reports the limit, with a readable message. |
| Query string `token` removed from access logs | Pre-2.1 clients sent the session token in `/ws?token=`. 2.1 sends it in the first WebSocket frame instead. |
| `Cache-Control: no-store` on `/api/*` (set by the relay) | No proxy or CDN in front can cache ciphertext or directory data. |
| Compression for text only | Encrypted blobs don't compress. |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| **Test connection:** *Couldn't reach …* | DNS not pointing at the VPS yet, port 443 blocked (ufw or OVHcloud Network Firewall), or the certificate hasn't been issued — `journalctl -u caddy -n 50`. |
| **Test connection:** *HTTPS works, but WebSocket connections aren't getting through* | A proxy in the path isn't forwarding `Upgrade`/`Connection`. The shipped configs do; check any extra layer (Cloudflare proxy → enable WebSockets). |
| **Test connection:** *…answered, but not like a Lattix relay* | The proxy points at the wrong upstream; check `127.0.0.1:8000` and `systemctl status lattix`. |
| `certbot` fails | Port 80 must be reachable from the internet for the HTTP challenge. |
| `502` for a few seconds after an update | nginx only: the relay was still starting. Clients retry reads automatically; Caddy holds requests until the relay is back. |
| Uploads fail with *larger than the relay (or the proxy) accepts* | Re-run the installer with `--max-file-mb N`. |
