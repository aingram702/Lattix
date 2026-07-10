# Deploying Lattix

This guide gets Lattix running on the public internet, reachable from anywhere,
over HTTPS.

---

## Read this first — two things that shape every option

**1. HTTPS is mandatory.** Lattix does all its cryptography in the browser using
the Web Crypto API (`crypto.subtle`), which browsers only expose in a **secure
context**. Served over plain `http://` (anything other than `localhost`) the app
will fail to generate keys or log in. Every option below terminates TLS so the
app is reached over `https://` — and because the client picks `wss://`
automatically on HTTPS pages, real-time delivery works with no extra config.

**2. Run a single instance.** Login tokens, live WebSocket connections, and the
rate limiter are held **in memory** in one process. That keeps the relay simple
and dependency-free, but it means you must run **exactly one instance** — do not
enable horizontal autoscaling. A second replica wouldn't share sessions and
couldn't deliver real-time messages to users connected to the other replica.
One small instance comfortably serves a family or a team; to scale out later you
would move sessions/pub-sub into Redis.

Because everything (including uploaded file blobs) lives in a single **SQLite**
file, "persistence" just means **one durable volume** mounted at `/data`.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8000` | Port to listen on. Most platforms inject this; the container honors it. |
| `LATTIX_DB` | `<app>/data/lattix.db` | SQLite path. **Point this at your mounted volume**, e.g. `/data/lattix.db`. |
| `LATTIX_MAX_FILE_MB` | `50` | Max encrypted file upload size. |
| `LATTIX_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which upstream IPs may set `X-Forwarded-For`. Set to `*` **only** when the app is reachable solely through a trusted proxy (see the security note). Needed for correct per-IP rate limiting behind a proxy. |
| `LATTIX_CORS_ORIGINS` | *(none)* | Comma-separated CORS allowlist. Only needed if you serve the client from a different origin than the API; the bundled app is same-origin and needs none. |
| `LATTIX_DOCS_URL` | `/api/docs` | Set to empty to disable the interactive API docs in production. |

---

## Option A — Your own server with Docker + automatic HTTPS (recommended)

The most robust, fully-owned setup. A single VPS runs the relay plus
[Caddy](https://caddyserver.com/), which fetches and renews a Let's Encrypt
certificate automatically. Files: [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
and [`deploy/Caddyfile`](deploy/Caddyfile).

**You need:** a small Linux VPS (1 GB RAM is plenty — DigitalOcean, Hetzner,
Linode, Vultr, AWS Lightsail…) and a domain name.

**1. Point DNS at the server.** Create an `A` record (and `AAAA` if you have
IPv6) for e.g. `chat.example.com` → your server's public IP. Wait for it to
resolve (`dig +short chat.example.com`).

**2. Open the firewall** for ports **80** and **443** (needed for the
certificate challenge and traffic). If using `ufw`:
```bash
sudo ufw allow 80,443/tcp && sudo ufw reload
```

**3. Install Docker** (includes Compose v2):
```bash
curl -fsSL https://get.docker.com | sh
```

**4. Get the code and configure your domain:**
```bash
git clone https://github.com/aingram702/Lattix.git
cd Lattix/Lattix/deploy
echo "LATTIX_DOMAIN=chat.example.com" > .env
```

**5. Launch:**
```bash
docker compose up -d --build
```
Caddy will obtain the certificate within a few seconds. Watch progress with
`docker compose logs -f caddy`.

**6. Verify:** open `https://chat.example.com`. You should get the padlock and
the Lattix welcome screen. Check health: `curl https://chat.example.com/api/health`.

That's it — the relay is reachable worldwide over HTTPS/WSS. The app container
is **not** published to the host (only Caddy is), so trusting forwarded client
IPs is safe.

**Update later:**
```bash
cd Lattix && git pull && cd Lattix/deploy && docker compose up -d --build
```

**Back up** (the whole app is in one file):
```bash
docker run --rm -v deploy_lattix-data:/data -v "$PWD":/backup alpine \
  cp /data/lattix.db /backup/lattix-backup-$(date +%F).db
```

---

### Using the prebuilt image (optional)

The [`docker-image`](../.github/workflows/docker-image.yml) workflow publishes a
ready-to-run image to `ghcr.io/<owner>/lattix`. To use it instead of building
from source, replace the `lattix` service's `build:` block in
`docker-compose.yml` with `image: ghcr.io/<owner>/lattix:latest`.

---

## Option B — Render (managed, no server to run)

Uses [`deploy/render.yaml`](deploy/render.yaml). Render terminates TLS, gives you
an `https://…onrender.com` domain (or a custom domain), supports WebSockets, and
injects `$PORT`.

1. Copy `deploy/render.yaml` to your **repository root** and push it (Render
   reads the blueprint from the root; this repo keeps the app under `Lattix/`,
   which the blueprint's `rootDir` handles).
2. In Render: **New + → Blueprint**, select your repo, apply.
3. A persistent disk (mounted at `/data`, matching `LATTIX_DB`) requires a
   **paid instance type** — the free tier has an ephemeral filesystem and will
   lose all accounts/messages on every deploy or restart. Keep instance count at
   **1**.
4. Visit the service URL. Add a custom domain under the service's *Settings* if
   you like.

---

## Option C — Fly.io (managed, global edge)

Uses [`deploy/fly.toml`](deploy/fly.toml). Fly gives HTTPS + WebSockets and a
`.fly.dev` domain.

```bash
# from the Lattix/ app directory
cp deploy/fly.toml ./fly.toml           # then edit `app` to a unique name
fly launch --no-deploy                  # or: fly apps create lattix-yourname
fly volumes create lattix_data --size 1 --region iad   # persistent /data
fly deploy
```
The config keeps **one always-on machine** (`min_machines_running = 1`,
`auto_stop_machines = false`) so in-memory sessions survive; don't scale it
beyond one machine.

---

## Option D — Railway / other Docker PaaS

Any platform that builds a Dockerfile works. Railway auto-detects the
[`Dockerfile`](Dockerfile) (set the service **Root Directory** to `Lattix`), or
uses the [`Procfile`](Procfile). Then:

- Add a **persistent volume** mounted at `/data` and set `LATTIX_DB=/data/lattix.db`.
- Set `LATTIX_FORWARDED_ALLOW_IPS=*` (traffic arrives via the platform proxy).
- Keep it to **one instance**.

---

## Connecting the Chrome extension

After deploying, open the extension, go to **Settings → Relay server**, and set
it to your HTTPS URL (e.g. `https://chat.example.com`). All crypto still runs
locally; only ciphertext reaches the server.

---

## Security checklist

- ✅ **HTTPS only** — never expose the app over plain HTTP (crypto won't run, and
  the login secret would be sent in the clear).
- ✅ **Don't publish the app container directly.** In Option A only Caddy binds
  80/443; the relay is internal. Only set `LATTIX_FORWARDED_ALLOW_IPS=*` when a
  trusted proxy is the sole path to the app — otherwise a client could spoof
  `X-Forwarded-For` to dodge rate limiting.
- ✅ **Persist `/data`** and back it up — it holds every account and message.
- ✅ Optionally set `LATTIX_DOCS_URL=` to hide the API docs.
- ℹ️ The server is a zero-knowledge relay: it only ever stores ciphertext and
  public keys, so a server compromise does not reveal message contents. Users
  should still verify contact **safety codes** to defend against a malicious
  server substituting keys.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "Cannot generate keys" / crypto errors | The page isn't a secure context. You must use `https://` (or `localhost`). |
| Real-time messages don't arrive, but appear after refresh | WebSocket isn't reaching the app. Ensure the proxy forwards `/ws` (Caddy does automatically) and that you're on `https://` so the client uses `wss://`. |
| Everyone shares one rate-limit bucket / gets 429s together | Proxy client IP isn't being forwarded. Set `LATTIX_FORWARDED_ALLOW_IPS=*` (behind a trusted proxy only). |
| Accounts/messages vanish after a redeploy | No persistent volume. Mount one at `/data` and set `LATTIX_DB=/data/lattix.db` (paid tier on some PaaS). |
| Large file uploads rejected | Raise `LATTIX_MAX_FILE_MB` and, in Option A, the Caddy `max_size` in the Caddyfile. |
| Certificate won't issue (Option A) | DNS must resolve to the server and ports 80/443 must be open before `docker compose up`. Check `docker compose logs caddy`. |
