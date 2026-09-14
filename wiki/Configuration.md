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
| `LATTIX_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which upstream IPs may set `X-Forwarded-For`. Set to `*` **only** when the app is reachable solely through a trusted reverse proxy — needed for correct per-IP rate limiting behind a proxy. |
| `LATTIX_CORS_ORIGINS` | *(none)* | Comma-separated CORS allowlist. Only needed if the client is served from a **different** origin than the API; the bundled web app is same-origin and needs none. |
| `LATTIX_DOCS_URL` | `/api/docs` | Interactive API docs path. Set to empty (`LATTIX_DOCS_URL=`) to disable docs in production. |

## Fixed constants (in code)

These are not env-configurable but are worth knowing:

- **Token lifetime:** 12 hours (`TOKEN_TTL`).
- **Auth hashing:** PBKDF2-SHA-256, 200,000 iterations, per-user 16-byte salt.
- **Rate limit:** 10 attempts per 5-minute window, per IP, on register/login.
- **Vault & backup KDF:** PBKDF2-SHA-256, 250,000 iterations (client-side).
- **Message payload cap:** ~2 MB of JSON (file *contents* go through
  `/api/files`, not the message payload).
- **Disappearing-message timers:** Off / 30 s / 5 min / 1 h / 1 day / 1 week
  (client), bounded to ≤ 4 weeks server-side.

## Where data is stored

- **Server:** the single SQLite file at `LATTIX_DB` (accounts, envelopes, and
  encrypted file blobs). Back up this one file.
- **Desktop app:** the database lives per-user —
  `%LOCALAPPDATA%\Lattix` (Windows),
  `~/Library/Application Support/Lattix` (macOS),
  `~/.local/share/lattix` (Linux).
- **Client:** your encrypted vault and UI preferences live in the browser's
  `localStorage` (keys prefixed `lattix.`). "Delete application data" clears
  them.

See [Self-Hosting & Deployment](Self-Hosting-and-Deployment) for how these map
onto Docker, Render, and Fly.
