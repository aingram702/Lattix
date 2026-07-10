# API Reference

The relay exposes a small REST API plus one WebSocket. **All message/file
payloads are opaque** — the server never inspects the crypto structure, so this
API is agnostic to the client's encryption scheme.

- **Base URL:** your relay origin (e.g. `https://chat.example.com`).
- **Auth:** send `Authorization: Bearer <token>` on every endpoint except
  register, login, health, and static assets.
- **Interactive docs:** `GET /api/docs` (disable in prod with `LATTIX_DOCS_URL=`).
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
Errors: `409` username taken, `429` rate-limited.

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

### `GET /api/users?q=<query>`
Substring search of the directory (excludes yourself).
→ `[{ "username": "...", "fingerprint": "...", "avatar": null }, ...]`

### `GET /api/me`
→ `{ "username", "fingerprint", "avatar", "contacts": [...], "groups": [...] }`

### `PUT /api/me/avatar`
Body: `{ "avatar": "data:image/png;base64,..." }` (or `null` to clear).
→ `{ "ok": true, "avatar": "..." }`

### `DELETE /api/me`
Irreversibly deletes the account and everything it owns (envelopes, files, group
memberships, owned groups) and revokes its tokens. → `{ "ok": true }`

## Messaging (1:1)

### `POST /api/messages`
Body: `{ "recipient": "bob", "payload": { ...opaque... }, "ttl": 3600 }`
(`ttl` optional, seconds; enables disappearing messages.)
→ the stored envelope: `{ "id", "sender", "recipient", "kind": "message",
"payload", "expires_at", "created_at" }`

### `POST /api/messages/file`
Body: `{ "recipient", "file_id", "filename", "mime", "size", "payload", "ttl?" }`
→ the stored `kind: "file"` envelope.

### `GET /api/conversations/{peer}?since=<id>`
All envelopes exchanged with `peer`, oldest first, id greater than `since`.

### `GET /api/inbox?since=<id>`
Everything addressed to you across all conversations.

## Groups

### `POST /api/groups`
Body: `{ "name": "Family", "members": ["bob", "carol"], "icon": "👪" }`
→ group detail (id, name, icon, owner, `members[]` with each member's public
keys).

### `GET /api/groups`
Groups you belong to.

### `GET /api/groups/{id}`
Full detail incl. members' public keys (members only).

### `POST /api/groups/{id}/members`
Body: `{ "username": "dave" }` (owner only). → updated group.

### `DELETE /api/groups/{id}/members/{username}`
Owner removes anyone; any member removes themselves (leave). → `{ "ok": true }`

### `POST /api/groups/{id}/messages`
Body: `{ "payload": { ... }, "ttl?": 300 }` (members only).

### `POST /api/groups/{id}/messages/file`
Body: `{ "file_id", "filename", "mime", "size", "payload", "ttl?" }`.

### `GET /api/groups/{id}/messages?since=<id>`
Group history (members only).

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

### `WS /ws?token=<token>`
After connecting you receive JSON events:
```json
{ "type": "envelope",       "envelope": { ... } }   // 1:1 message/file
{ "type": "group_envelope", "envelope": { ... } }   // group message/file
{ "type": "group",  "action": "created|members", "group_id": 1 }
{ "type": "presence", "username": "bob", "online": true }
```
Send any text (e.g. `"ping"`) to keep the socket alive. Presence is sent only to
your contacts.

### `GET /api/health`
→ `{ "status": "ok", "version": "1.1.0" }` (no auth) — for load-balancer probes.

---

For a concrete, runnable client of this API, see
`scripts/integration_test.mjs` in the repo, and the
[Development & Contributing](Development-and-Contributing) page.
