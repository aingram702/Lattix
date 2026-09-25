# API Reference

The relay exposes a small REST API plus one WebSocket. **All message/file
payloads are opaque** — the server never inspects the crypto structure, so this
API is agnostic to the client's encryption scheme.

- **Base URL:** your relay origin (e.g. `https://chat.example.com`).
- **Auth:** send `Authorization: Bearer <token>` on every endpoint except
  register, login, health, and static assets. Tokens live in the relay's memory
  for 12 hours; after a relay restart every request answers `401`, and clients
  log in again with the unlocked identity.
- **CORS:** the desktop apps (`http://localhost:*`, `http://127.0.0.1:*`) and the
  Chrome extension (`chrome-extension://…`) may call a relay on another origin by
  default; add others with `LATTIX_CORS_ORIGINS`. No cookies are used.
- **Caching:** `/api/*` responses carry `Cache-Control: no-store`; the static
  client carries `no-cache` (revalidate) so a redeploy is picked up at once.
- **Interactive docs:** `GET /api/docs`, schema at `GET /api/openapi.json`. Setting
  `LATTIX_DOCS_URL=` (empty) disables both. `/redoc` is not served.
- **History paging:** history endpoints return at most `history_page_size`
  envelopes (see `/api/health`; 500), oldest first. Page with `?since=<last id>`
  until a page comes back shorter than that.
- **Usernames** must match `^[a-zA-Z0-9_.-]{3,32}$` and are lower-cased server-side.

## Auth & directory

### `POST /api/register`
Body:
```json
{
  "username": "ada",
  "kem_public_key": "<base64>",
  "dsa_public_key": "<base64>",
  "fingerprint": "<hex sha-256 of the two public keys>",
  "auth_secret": "<base64 random>",
  "avatar": "data:image/...  (optional)"
}
```
→ `{ "token": "...", "username": "ada", "expires_at": 1234567890.0 }`

Validation (2.2): `kem_public_key` must decode to exactly **1,184** bytes
(ML-KEM-768), `dsa_public_key` to **1,952** bytes (ML-DSA-65), and `fingerprint`
must equal lowercase hex `SHA-256(kem_public_key ‖ dsa_public_key)` of the
decoded keys.

Errors: `409` username taken (also when two registrations race), `422`
malformed body, wrong key size or mismatched fingerprint, `429` rate-limited.

### `POST /api/login`
Body: `{ "username": "ada", "auth_secret": "..." }` → token (same shape).
Errors: `401` invalid credentials (returned identically whether or not the user
exists), `429` rate-limited.

### `POST /api/logout`
Invalidates the bearer token. → `{ "ok": true }`

### `GET /api/users/{username}`
→ `PublicUser`:
```json
{ "username": "bob", "kem_public_key": "...", "dsa_public_key": "...",
  "fingerprint": "...", "avatar": null }
```
Clients should **not trust `fingerprint`** — recompute it from the two keys.
The Lattix client does, and pins the result (see
[Security & Trust Model](Security-and-Trust-Model)).

### `GET /api/users?q=<query>`
Substring search of the directory (excludes yourself).
→ `[{ "username": "...", "fingerprint": "...", "avatar": null }, ...]`

### `GET /api/me`
→ `{ "username", "fingerprint", "avatar", "contacts": [...], "groups": [...] }`

### `PUT /api/me/avatar`
Body: `{ "avatar": "data:image/png;base64,..." }` (or `null` to clear).
→ `{ "ok": true, "avatar": "..." }`

### `DELETE /api/me`
Irreversibly deletes the account: its envelopes, file blobs and group
memberships. Then it:

- revokes every token and closes the account's open WebSockets with code **4401**;
- sends `presence` `online: false` to its former contacts;
- **hands each group it owned to the longest-standing remaining member** (a
  group with nobody else in it is deleted) and sends those groups' members a
  `group` / `members` event.

Before 2.2, deleting an owner's account deleted their groups for everyone.
→ `{ "ok": true }`

## Messaging (1:1)

### `POST /api/messages`
Body: `{ "recipient": "bob", "payload": { ...opaque... }, "ttl": 3600 }`
(`ttl` optional, seconds; enables disappearing messages.)
→ the stored envelope: `{ "id", "sender", "recipient", "kind": "message",
"payload", "expires_at", "created_at" }`

### `POST /api/messages/file`
Body: `{ "recipient", "file_id", "filename", "mime", "size", "payload", "ttl?" }`
→ the stored `kind: "file"` envelope.

- `file_id` must be 32 hex characters and name a blob **you** uploaded
  (otherwise `404`). The relay sets `payload.file_id` to it.
- `filename` and `mime` (≤ 255 chars) are stored in the clear. 2.2 clients send
  the placeholders `"file"` and `"application/octet-stream"` and carry the real
  values encrypted inside `payload` (file format v2 — see
  [Cryptography](Cryptography)). The relay copies these fields into `payload`
  only if it lacks them.

### `GET /api/conversations/{peer}?since=<id>`
Envelopes exchanged with `peer` with id greater than `since`, oldest first, at
most `history_page_size` per call — page with `since`.

### `GET /api/inbox?since=<id>`
Everything addressed to you across all conversations (up to 1,000 per call).
The Lattix client doesn't use it.

## Groups

### `POST /api/groups`
Body: `{ "name": "Family", "members": ["bob", "carol"], "icon": "👪" }`
(`name` 1–64 chars; up to 256 `members`, each a valid username — unknown users
are skipped; `icon` up to 8 characters, i.e. one emoji.)
→ group detail (id, name, icon, owner, `members[]` with each member's public
keys).

### `GET /api/groups`
Groups you belong to.

### `GET /api/groups/{id}`
Full detail incl. members' public keys (members only).

### `POST /api/groups/{id}/members`
Body: `{ "username": "dave" }` (owner only). → updated group.

### `DELETE /api/groups/{id}/members/{username}`
Owner removes anyone; any member removes themselves (leave). If the owner
leaves, ownership passes to the longest-standing member; the group is deleted
when its last member leaves. → `{ "ok": true }`

### `POST /api/groups/{id}/messages`
Body: `{ "payload": { ... }, "ttl?": 300 }` (members only).

### `POST /api/groups/{id}/messages/file`
Body: `{ "file_id", "filename", "mime", "size", "payload", "ttl?" }`.

### `GET /api/groups/{id}/messages?since=<id>`
Group history (members only), paged like conversations.

## Files

### `POST /api/files`
`multipart/form-data`: `file=<ciphertext blob>`, `size=<plaintext size>`.
→ `{ "file_id": "..." }`. Rejected with `413` over `LATTIX_MAX_FILE_MB`.

### `GET /api/files/{file_id}`
Returns the raw ciphertext (`application/octet-stream`) with an
`X-Plaintext-Size` header. Authorized only for the uploader, a
sender/recipient of a message referencing it, or a member of a group that
referenced it (otherwise `404`).

## Realtime & health

### `WS /ws`
Authenticate with the **first frame** (2.1+):
```json
{ "type": "auth", "token": "<token>" }
```
The relay answers `{ "type": "ready", "username": "ada" }`, or closes the socket
with code **4401** if the token is missing, invalid or expired (for example
because the relay restarted and its in-memory sessions are gone). It waits 10
seconds for the auth frame. Keeping the token out of the URL matters behind a
reverse proxy: Caddy, nginx and uvicorn log the request line, query string
included.

`WS /ws?token=<token>` still works for 1.x/2.0 clients.

After `ready` you receive JSON events:
```json
{ "type": "envelope",       "envelope": { ... } }   // 1:1 message/file
{ "type": "group_envelope", "envelope": { ... } }   // group message/file
{ "type": "group",  "action": "created|members", "group_id": 1 }
{ "type": "presence", "username": "bob", "online": true }
```
Send the text frame `"ping"` periodically; the relay answers `{ "type": "pong" }`.
Other client frames, including binary ones, are ignored. The client
pings every 25 s and treats a ping with no reply within 10 s as a dead socket
(silently dropped by a proxy idle timeout, NAT or sleep), then reconnects and
fetches anything it missed over REST. Presence is sent only to your contacts.

**Presence snapshot (2.0).** On connect the relay immediately sends one
`presence` event per contact who is *already* online, then continues to send
events on transitions as before. It also refreshes presence for both parties when
an envelope is delivered — a first message is what makes two users contacts, and
that produces no connect transition of its own. Without the snapshot a client
learned nothing about contacts already connected, so everyone showed as offline
after a reload.

### `GET /api/health`
→ (no auth) — for load-balancer probes:
```json
{
  "status": "ok", "version": "2.2.0", "max_file_bytes": 52428800,
  "time": 1790290000.0, "history_page_size": 500,
  "features": ["ws-auth-message", "ws-pong", "history-paging", "cors-local"]
}
```
`features` (2.1) lists what the relay supports, so clients and the Settings →
Relay server **Test connection** check don't have to guess from the version:
`ws-auth-message` (first-frame WebSocket auth), `ws-pong` (answers pings),
`history-paging` (2.2: history endpoints are capped at `history_page_size` and
should be paged), `cors-local` (desktop-app and extension origins allowed).

`history_page_size` (2.2) is the most envelopes one history request returns.

`max_file_bytes` (added in 2.0) is `LATTIX_MAX_FILE_MB` in bytes. The client reads
it at boot so it can reject an oversized attachment *before* encrypting it, rather
than doing the work and then taking a `413`. Older clients ignore the field.

---

For a concrete, runnable client of this API, see
`scripts/integration_test.mjs` in the repo, and the
[Development & Contributing](Development-and-Contributing) page.
