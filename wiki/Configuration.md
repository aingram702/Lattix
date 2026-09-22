# Configuration

Lattix is configured entirely through **environment variables** — no config
files to edit.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8000` | Port to listen on. Honored by the container and `run.py`; most hosting platforms inject it. |
| `LATTIX_HOST` | `127.0.0.1` | Bind address for `run.py` (use `0.0.0.0` to expose on a network). |
| `LATTIX_DB` | `<app>/data/lattix.db` | SQLite database path. **Point this at a persistent volume**, e.g. `/data/lattix.db`. The DB holds accounts, messages, and file blobs. |
| `LATTIX_MAX_FILE_MB` | `50` | Maximum encrypted file upload size, in MB. |
| `LATTIX_CLIENT_DIR` | `<app>/client` | Directory of the static client to serve (set automatically by the desktop installers). |
| `LATTIX_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which upstream IPs may set `X-Forwarded-For`. Behind a proxy on the same host (the Debian VPS install) keep `127.0.0.1`. Set to `*` **only** when the app is reachable solely through a trusted reverse proxy (e.g. Docker Compose). Needed for correct per-IP rate limiting behind a proxy. |
| `LATTIX_KEEPALIVE` | `75` | Idle HTTP keep-alive, seconds (`run.py`, container, systemd unit). Must exceed the reverse proxy's upstream keep-alive (60 s in the shipped Caddy/nginx configs), or pooled connections get closed under the proxy and surface as sporadic `502`s. |
| `LATTIX_CORS_ORIGINS` | *(none)* | Extra comma-separated origins allowed to call the API cross-origin, or `*`. Only needed if you host the web client on a **different** origin; the bundled web app is same-origin, and desktop/extension origins are covered by the next variable. |
| `LATTIX_CORS_ALLOW_LOCAL` | `1` | Allow the desktop apps (`http://localhost:*`, `http://127.0.0.1:*`) and the Chrome extension to use this relay remotely. Set `0` for a relay only its own web app should reach. |
| `LATTIX_DOCS_URL` | `/api/docs` | Interactive API docs path. Set to empty (`LATTIX_DOCS_URL=`) to disable docs in production. |
| `LATTIX_RATE_LIMIT_MAX` | `10` | Sign-in/registration attempts allowed per IP per window. Raise it for a household or office behind one NAT address; `0` disables auth rate limiting (test relays only). |
| `LATTIX_RATE_LIMIT_WINDOW` | `300` | Length of that window, in seconds. |

## Fixed constants (in code)

These are not env-configurable but are worth knowing:

- **Token lifetime:** 12 hours (`TOKEN_TTL`).
- **Auth hashing:** PBKDF2-SHA-256, 200,000 iterations, per-user 16-byte salt.
- **Orphaned file blobs:** the background sweep runs every 60 s and deletes any
  encrypted blob that no message references, once it is more than 6 hours old
  (the grace period covers an upload whose message hasn't been posted yet).
- **Vault & backup KDF:** PBKDF2-SHA-256, 250,000 iterations (client-side).
- **Message payload cap:** ~2 MB of JSON (file *contents* go through
  `/api/files`, not the message payload).
- **Disappearing-message timers:** Off / 30 s / 5 min / 1 h / 1 day / 1 week
  (client), bounded to ≤ 4 weeks server-side. Expiry is applied by a periodic
  client-side sweep and a background server sweep.
- **Message render window:** the most recent 200 messages are kept in the DOM;
  older ones load on demand via **Load earlier** (client-side only — nothing is
  dropped from memory or from the server).
- **Inline image previews:** limited to image MIME types under a fixed size cap,
  and only for messages whose signature verified. Off by default
  (**Settings → Media**).
- **WebSocket reconnect:** exponential backoff with ±20% jitter, factor 1.6,
  capped at 20 s; immediate when the network or the tab comes back.
- **WebSocket heartbeat:** ping every 25 s; no pong within 10 s drops and
  reconnects. After any reconnect the client fetches what it missed.
- **Request timeouts:** 30 s for API calls, 10 min for file transfers. Reads
  (`GET`) retry twice on network errors and `502/503/504`; writes never retry.
- **WebSocket auth wait:** 10 s for the first-frame `auth` message.

## Client setting: relay server

Which relay a client uses is chosen in the app, not by environment variable:
the **Relay: … Change** link on the sign-in screen, or **Settings → Relay server
→ Change…**. It is stored in the browser's `localStorage` (`lattix.serverUrl`)
for that app's origin. Empty means the default — the relay the page was loaded
from (web app, desktop apps) or `http://localhost:8000` (Chrome extension).

## Where data is stored

- **Server:** the single SQLite file at `LATTIX_DB` (accounts, envelopes, and
  encrypted file blobs). Back up this one file.
- **Desktop app:** the database lives per-user —
  `%LOCALAPPDATA%\Lattix` (Windows),
  `~/Library/Application Support/Lattix` (macOS),
  `~/.local/share/lattix` (Linux).
- **Client:** your encrypted vault, decrypted chat cache, UI preferences, and
  unsent **drafts** live in the browser's `localStorage` (keys prefixed
  `lattix.`, drafts under `lattix.draft.*`). "Delete application data" clears
  them all.

See [Self-Hosting & Deployment](Self-Hosting-and-Deployment) for how these map
onto Docker, Render, and Fly.
