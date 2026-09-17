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
| `js/api.js` | REST + WebSocket client (transports only ciphertext): timeouts, read retries, automatic re-login after a relay restart, first-frame WebSocket auth, ping/pong watchdog, reconnect reporting for resync. |
| `js/config.js` | Relay server setting for every build (sign-in screen and Settings), URL validation, share-link origin. |
| `js/preload.js` | Applies the stored theme before the first paint. Must stay a *separate file* — MV3's CSP forbids inline script, so the usual inline anti-flash snippet isn't available. |
| `js/theme.js`, `js/sound.js`, `js/qr.js` | Theming, notification tones, offline QR generator. |
| `vendor/lattix-pqc.js` | Vendored, offline build of `@noble/post-quantum`. |

Private keys live only in memory after the encrypted **vault** is unlocked; the
vault (and encrypted backups) are sealed with your password.

### Rendering

`app.js` holds decrypted conversation state in memory and renders from it. Two
properties keep that affordable as a history grows:

- **Renders are batched.** `scheduleMessages()` / `scheduleContacts()` coalesce
  into a single `requestAnimationFrame` callback, so a burst of envelopes — boot
  replay above all — costs one render pass, not one per envelope. Unbatched, boot
  is quadratic in history length.
- **The message list is windowed.** Only the most recent *N* messages are in the
  DOM; a **Load earlier** control widens the window and preserves scroll position.
  Nothing is dropped from state — only from the document.

Disappearing messages are removed by a single periodic **sweep** over state rather
than one `setTimeout` registered per message at ingest.

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

Because the connection map is what presence is derived from, the relay sends each
client a **presence snapshot** on connect (contacts already online) and refreshes
presence for both parties on envelope delivery — a first message is what makes two
users contacts, and that produces no connect transition of its own.

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
Lattix/                        # repository root
├── run.py                     # launcher (uvicorn wrapper)
├── requirements.txt
├── Dockerfile, Procfile       # hosting
├── deploy/                    # docker-compose + Caddy, Render, Fly configs
├── server/                    # zero-knowledge relay (FastAPI)
│   ├── main.py  database.py  models.py
├── client/                    # single-page app (also a Chrome extension)
│   ├── index.html  css/  js/  vendor/  icons/  manifest.json  background.js
├── installer/                 # Windows / macOS / Linux installer builds
└── scripts/                   # vendor build, protocol test, nine browser UI suites
    └── lib/harness.mjs        #   shared signup/unlock test helpers
```
