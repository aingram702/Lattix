# Architecture

Lattix has two halves: a **client** that does all cryptography, and a **relay
server** that stores and forwards opaque data. The security model does not
depend on trusting the server (see [Security & Trust Model](Security-and-Trust-Model)).

```
┌───────────────────────────┐        HTTPS / WSS        ┌────────────────────────────┐
│  Client (browser / ext.)  │  ───────────────────────► │  Relay server (FastAPI)    │
│                           │                           │                            │
│  crypto.js  ML-KEM/ML-DSA │   opaque encrypted        │  main.py    REST + WS      │
│  AES-GCM, HKDF, PBKDF2    │   envelopes + public keys │  database.py  SQLite       │
│  vault (keys never leave) │  ◄──────────────────────  │  models.py    schemas      │
│  app.js  UI + state       │   ciphertext, never keys  │  (stores ciphertext only)  │
└───────────────────────────┘                           └────────────────────────────┘
```

## Client

Static, dependency-free single-page app in `client/` (also loadable as a Chrome
MV3 extension). Key modules:

| File | Role |
|------|------|
| `js/crypto.js` | All E2E crypto: ML-KEM-768, ML-DSA-65, AES-256-GCM, HKDF, vault & backup sealing. |
| `js/app.js` | UI, conversation state, ingestion/decryption, all feature logic. |
| `js/api.js` | REST + WebSocket client (transports only ciphertext). |
| `js/config.js` | Runtime config (relay URL, used by the extension). |
| `js/theme.js`, `js/sound.js`, `js/qr.js` | Theming, notification tones, offline QR generator. |
| `vendor/lattix-pqc.js` | Vendored, offline build of `@noble/post-quantum`. |

Private keys live only in memory after the encrypted **vault** is unlocked; the
vault (and encrypted backups) are sealed with your password.

## Server

A single-process **FastAPI + uvicorn** app in `server/`:

- `main.py` — REST endpoints, the `/ws` WebSocket, static hosting of the client,
  in-memory token store, per-IP rate limiting, and a background sweep that purges
  expired (disappearing) messages.
- `database.py` — SQLite storage layer (guarded by a lock; single connection).
- `models.py` — Pydantic request/response schemas. Message/file payloads are
  treated as **opaque** blobs — the server never inspects the crypto structure.

See the [API Reference](API-Reference) for every endpoint.

## What lives in memory (and why it's single-instance)

Three things are kept in the server process, not a shared store:

- **Login tokens** — issued at login, checked on every request.
- **WebSocket connections** — the map of who is online, used to push envelopes.
- **Rate-limiter buckets** — per-IP sliding windows for `/api/register` and
  `/api/login`.

This keeps the relay simple and dependency-free, but it means Lattix must run as
**exactly one instance**. A second replica wouldn't share sessions and couldn't
deliver real-time messages to users connected to the other replica. One small
instance easily serves a family or team; scaling out would mean moving sessions
and pub/sub into Redis. See
[Self-Hosting & Deployment](Self-Hosting-and-Deployment).

## Message flow (1:1)

1. Sender's client generates a random 256-bit **content key (CEK)**, encrypts
   the message once with AES-256-GCM, and **wraps** the CEK for the recipient and
   for itself via ML-KEM-768 + HKDF. It signs the envelope with ML-DSA-65.
2. `POST /api/messages` stores the envelope and pushes it over `/ws` to the
   recipient (and the sender's other sessions) if online.
3. Offline recipients fetch it later via `GET /api/conversations/{peer}` or
   `GET /api/inbox`.
4. The recipient verifies the signature, unwraps their CEK, and decrypts.

Groups work the same way, wrapping the CEK for every member and binding the
signature to the group id. See [Cryptography](Cryptography).

## Data model (SQLite)

| Table | Holds |
|-------|-------|
| `users` | username, **public** KEM/DSA keys, fingerprint, auth salt + PBKDF2 hash, optional avatar. |
| `envelopes` | 1:1 messages/files: sender, recipient, kind, **opaque** payload, optional `file_id`, `expires_at`. |
| `files` | uploaded **ciphertext** blobs + plaintext size (metadata only). |
| `groups`, `group_members` | group metadata and membership. |
| `group_envelopes` | group messages/files (opaque payload, `expires_at`). |

The database file holds everything (including file blobs), so persisting a
single `/data` volume is all that's needed for durability.

## Project layout

```
Lattix/
├── run.py                     # launcher (uvicorn wrapper)
├── requirements.txt
├── Dockerfile, Procfile       # hosting
├── deploy/                    # docker-compose + Caddy, Render, Fly configs
├── server/                    # zero-knowledge relay (FastAPI)
│   ├── main.py  database.py  models.py
├── client/                    # single-page app (also a Chrome extension)
│   ├── index.html  css/  js/  vendor/  icons/  manifest.json  background.js
├── installer/                 # Windows / macOS / Linux installer builds
└── scripts/                   # vendor build + integration test
```
