# Self-Hosting & Deployment

This page summarizes hosting Lattix as a public service. The repository's
[`DEPLOYMENT.md`](https://github.com/aingram702/Lattix/blob/main/Lattix/DEPLOYMENT.md)
has the full, copy-pasteable walkthroughs.

## Two rules that shape every option

1. **HTTPS is mandatory.** Browser crypto (`crypto.subtle`) only works in a
   secure context. Anything other than `localhost` must be served over
   `https://`. Because the client auto-selects `wss://` on HTTPS pages, real-time
   delivery then works with no extra config.
2. **Run a single instance.** Tokens, WebSocket connections, and the rate limiter
   are in memory (see [Architecture](Architecture)). Do **not** autoscale — a
   second replica breaks sessions and real-time delivery. Persist one `/data`
   volume for the SQLite database (which also holds file blobs).

See [Configuration](Configuration) for every environment variable.

## Option A — Your own server with Docker + automatic HTTPS (recommended)

A single VPS runs the relay plus **Caddy**, which fetches and renews a Let's
Encrypt certificate automatically. Files:
[`deploy/docker-compose.yml`](https://github.com/aingram702/Lattix/blob/main/Lattix/deploy/docker-compose.yml)
and [`deploy/Caddyfile`](https://github.com/aingram702/Lattix/blob/main/Lattix/deploy/Caddyfile).

```bash
# 1. DNS: point chat.example.com -> your server's public IP (A/AAAA record)
# 2. Open ports 80 and 443 on the firewall
# 3. Install Docker:
curl -fsSL https://get.docker.com | sh
# 4. Configure your domain and launch:
git clone https://github.com/aingram702/Lattix.git
cd Lattix/Lattix/deploy
echo "LATTIX_DOMAIN=chat.example.com" > .env
docker compose up -d --build
```

Open `https://chat.example.com` — you should get the padlock and the welcome
screen. The app container is **not** published to the host (only Caddy is), so
`LATTIX_FORWARDED_ALLOW_IPS=*` is safe there.

**Update:** `git pull && docker compose up -d --build`.
**Back up:**
```bash
docker run --rm -v deploy_lattix-data:/data -v "$PWD":/backup alpine \
  cp /data/lattix.db /backup/lattix-backup-$(date +%F).db
```

### Prebuilt image

The `docker-image` workflow publishes an image to `ghcr.io/<owner>/lattix`. To
use it instead of building, replace the `lattix` service's `build:` block with
`image: ghcr.io/<owner>/lattix:latest`.

## Option B — Render

Uses [`deploy/render.yaml`](https://github.com/aingram702/Lattix/blob/main/Lattix/deploy/render.yaml).
Render terminates TLS, supports WebSockets, and injects `$PORT`. Copy
`render.yaml` to the **repository root**, then create a **Blueprint** in the
Render dashboard. A **persistent disk** (mounted at `/data`) needs a paid
instance type — the free tier's filesystem is ephemeral and loses data on every
deploy. Keep instance count at **1**.

## Option C — Fly.io

Uses [`deploy/fly.toml`](https://github.com/aingram702/Lattix/blob/main/Lattix/deploy/fly.toml).

```bash
cp deploy/fly.toml ./fly.toml           # edit `app` to a unique name
fly launch --no-deploy
fly volumes create lattix_data --size 1 --region iad
fly deploy
```
The config keeps one always-on machine so in-memory state survives.

## Option D — Railway / other Docker PaaS

Any Dockerfile-building platform works. Set the service **Root Directory** to
`Lattix`, add a **persistent volume** at `/data` with `LATTIX_DB=/data/lattix.db`,
set `LATTIX_FORWARDED_ALLOW_IPS=*`, and keep it to **one instance**. A
[`Procfile`](https://github.com/aingram702/Lattix/blob/main/Lattix/Procfile) is
included for buildpack-based platforms.

## Connecting clients

- **Web:** just open your HTTPS URL.
- **Extension:** Settings → Relay server → your HTTPS URL. See
  [Desktop Apps & Extension](Desktop-Apps-and-Extension).

## Security checklist

- ✅ HTTPS only (never plain HTTP off localhost).
- ✅ Don't publish the app container directly; only the reverse proxy binds
  80/443. Set `LATTIX_FORWARDED_ALLOW_IPS=*` only behind a trusted proxy.
- ✅ Persist and back up `/data`.
- ✅ Optionally `LATTIX_DOCS_URL=` to hide the API docs.

See [Security & Trust Model](Security-and-Trust-Model) and the deployment guide's
troubleshooting table for WebSocket/TLS/persistence gotchas.
