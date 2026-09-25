# Lattix 2.2.0 — code review, debug & documentation overhaul

**Reviewed:** `main` at `09c89f1` (2.1.1) — server, client, crypto, CI, deploy
configs and documentation.

**Method.** The existing suite (12 suites, ~310 checks) was run first as a
baseline; it passed. Every suspected defect was then reproduced against a live
relay (and, for the trust issues, in a real browser) *before* any fix was
written. Each fix has a regression test. `db_test.py` was also run against the
original database layer to confirm it fails there; the other findings were
confirmed failing on the original code by proof-of-concept scripts, which the
regression suites replace.

**Result.** 15 suites, all passing: the original 12 unchanged, plus
`db_test.py` (18), `regression_test.mjs` (39) and `ui_test_trust.mjs` (26).

---

## Findings

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | **Critical** | Client trust | Safety codes shown were the relay's `fingerprint` field, not a hash of the keys in use. |
| 2 | High | Client trust | No key pinning or change detection; the share link's `fp=` was discarded. |
| 3 | High | Relay data | Deleting a group owner's account deleted the group for every member. |
| 4 | Medium-High | File crypto | File signatures didn't cover the ciphertext; a recipient could substitute contents. |
| 5 | Medium | Privacy | File names and MIME types were stored in plaintext on the relay. |
| 6 | Medium | Client | History capped at 500 per request and never paged; newer messages lost. |
| 7 | Medium | Relay | Databases from before `file_id` crashed startup. |
| 8 | Medium | CI | All installer and Docker workflows built from a nonexistent `Lattix/` directory. |
| 9 | Medium | Docs/ops | Docker backup instructions `cp`'d a live WAL database — can lose data. |
| 10 | Low-Medium | Relay | Deleted accounts kept their WebSockets open. |
| 11 | Low-Medium | Relay | Directory accepted fingerprints not matching the keys, and keys of any size. |
| 12 | Low | Relay | `LATTIX_DOCS_URL=` hid `/api/docs` but left `/redoc` and `/openapi.json` public. |
| 13 | Low | Relay | Expired disappearing files kept their blob for up to 6 hours. |
| 14 | Low | Relay | Group roster entries unvalidated (200k-character "usernames" accepted). |
| 15 | Low | Relay | Racing registrations for one name returned `500`. |
| 16 | Low | Relay | A binary WebSocket frame raised `KeyError` in the receive loop. |
| 17 | Hardening | Vault | PBKDF2 at 250k iterations; current OWASP guidance is 600k. |
| 18 | Docs | README/wiki | Several claims contradicted the code (see below). |

---

### 1. Safety codes came from the relay — Critical

`openFingerprint()` displayed `keys.fingerprint` as returned by
`GET /api/users/{name}`. Nothing ever hashed the keys the client actually
encrypted to. A malicious relay could serve an attacker's keys for Alice along
with Alice's genuine fingerprint string; Bob's **Verify** dialog then showed
Alice's correct code, comparison "succeeded", and Bob encrypted to the attacker.
This defeated the app's only defence against key substitution.

**Reproduced** in Chromium: relay row for `alice` rewritten to Mallory's keys,
fingerprint left intact; Bob's dialog showed Alice's real code.

**Fix.** All relay key records pass through `adoptPeerKeys()`, which computes
`SHA-256(kem ‖ dsa)` locally; the relay's field is never displayed, pinned or
compared. The Verify dialog re-fetches and shows the computed value.

### 2. No pinning; share-link fingerprint ignored — High

Keys were cached for the session only and nothing remembered what a user had
verified, so a later substitution went unnoticed. Share links and QR codes carry
`#add=<user>&fp=<code>` — a genuinely out-of-band copy of the code — but
`processDeepLink()` read only `add`.

**Fix.** Per-relay pins in `localStorage` (`lattix.pins.<origin>`), trust on
first use. For a **verified** contact whose key changes: red banner, their
messages render unverified, and `assertSendable()` blocks encryption to them
until the user reviews or accepts. Unverified contacts re-pin with a notice.
Share links compare `fp` with the computed code — match marks verified,
mismatch warns and blocks sending. The Verify dialog gained verified status and
a mark/unmark control. At sign-in the client checks that the relay publishes the
user's own real keys. Keys are re-fetched when a conversation or the Verify
dialog opens.

### 3. Owner account deletion destroyed the group — High

`groups.owner` is `ON DELETE CASCADE`. `remove_member` handled an owner
*leaving*, but `delete_user` cascaded straight through, deleting the group and
every member's history. **Reproduced:** member's `GET /api/groups/{id}` → 404.

**Fix.** `delete_user()` transfers each owned group to the longest-standing
remaining member in one transaction (dropping only groups with nobody left) and
returns affected groups so members get a `group`/`members` event.

### 4. File signature didn't cover the ciphertext — Medium-High

The v1 file transcript was metadata + IV + wrapped keys. Every recipient holds
the CEK, so a recipient could AES-GCM-encrypt different bytes under the same
CEK and IV; with the relay swapping the blob (or in a group, where the relay
colludes with any member), other recipients would decrypt the substitute and
see the sender's signature verify. **Reproduced** in Node: Mallory's forged
bytes decrypted for Bob under Alice's valid signature.

**Fix.** File format v2 signs `SHA-256(ciphertext)`; `decryptFile()` checks the
downloaded blob against it before decrypting. New domain prefix
(`lattix-file-v2\0<context>\0`) with fixed-length fields, so a v2 payload can't
be downgraded to v1 shape. v1 payloads still open.

### 5. Plaintext file names — Medium

`filename`, `mime`, `size` sat in the clear in the payload and top-level request,
contradicting the docs' "server can't read payloads". **Fix.** v2 encrypts them
under the CEK (`meta_iv`, `meta_ct`); the client sends the relay placeholders.
`openFilePayload()` verifies and decrypts metadata at ingest, without
downloading the file. Size remains visible (ciphertext length reveals it anyway).

### 6. History never paged — Medium

`get_conversation`/`get_group_messages` return 500 envelopes oldest-first; the
client made one request. A 505-message conversation reloaded with 500, and the
next live message advanced `maxId` past the gap, hiding the rest permanently.

**Fix.** `pullHistory()` pages with `since=` until a short page, at boot and in
reconnect resync. `/api/health` advertises `history_page_size` and a
`history-paging` feature.

### 7. Startup crash on old databases — Medium

`init_db()`'s script created `idx_env_file_id` on `envelopes(file_id)` *before*
`_migrate()` added the column: `sqlite3.OperationalError: no such column:
file_id`. **Fix.** Indexes on migrated columns are created after migration;
migrations now also cover `groups.icon` and `group_envelopes.file_id/expires_at`.

### 8. CI built from a nonexistent directory — Medium

The three installer workflows set `working-directory: Lattix` and uploaded
`Lattix/installer/...`; the Docker workflow used `context: Lattix`. The app is
at the repo root, so every build failed. Untagged Linux/macOS builds were also
hardcoded to version `1.1.0`. **Fix.** Build from the root; untagged builds read
`server.__version__`. Added `tests.yml`, running all suites on push and PRs.

### 9. Unsafe backup instructions — Medium

`DEPLOYMENT.md`, the Self-Hosting wiki page and the Tailscale guide backed up with
`cp /data/lattix.db`. The relay runs SQLite in WAL mode; committed writes can
live in `lattix.db-wal`. **Demonstrated:** a `cp` of a live WAL database holding
1,000 committed rows produced a copy in which the table did not exist; SQLite's
online backup captured all 1,000. **Fix.** All three now use
`sqlite3.Connection.backup()` via the container's Python. (`deploy/vps/README.md`
already used `.backup` correctly.)

### 10–16. Smaller relay fixes

- **Deleted accounts' sockets** (10) are closed with 4401 and contacts receive an
  offline presence event; previously sockets stayed live under a username that
  could be re-registered.
- **Directory integrity** (11): keys must decode to 1,184 / 1,952 bytes and the
  fingerprint must match them (`422`).
- **Docs exposure** (12): one setting now governs `/api/docs` and the schema,
  which moved to `/api/openapi.json`; `/redoc` is disabled.
- **Disappearing files** (13): `delete_expired()` removes blobs referenced only
  by expired envelopes in the same sweep.
- **Roster validation** (14): members are `list[Username]`.
- **Registration race** (15): `IntegrityError` → `409`.
- **Binary frames** (16): the loop uses `ws.receive()` and ignores non-text frames.

### 17. Vault work factor — Hardening

New vaults and backups: PBKDF2-SHA-256 at 600,000 iterations, stored as `iter`
(`v: 2`). Files without `iter` open at 250,000; after unlock or import the app
re-seals the vault at 600,000 in the background. Iteration counts outside
100k–10M are refused.

### 18. Documentation that contradicted the code

- Inline image previews were documented as **off by default**; the code defaults
  them **on** (README, Features, FAQ, Configuration).
- The README said share links open "a *verified* conversation"; they didn't.
- The wiki described plaintext file names as unreadable by the relay.
- Render and Fly instructions referred to a `Lattix/` app directory.
- Versions across the wiki and installer docs still read 2.1.0; test counts and
  suite lists were stale.

---

## Verified, not changed

- Message transcript construction, key wrapping and conversation binding are
  sound; 1:1 envelopes stay byte-compatible with 1.x.
- `messageHtml()` escapes before linkifying, and only `http(s)` URLs become
  links; avatars render via `<img src>` only; SVG is never previewed.
- File access control from 2.1.1 holds (`server_test.mjs`).
- Login timing is uniform for unknown users; tokens stay out of URLs.

## Remaining limitations (documented)

- Trust on first use: substitution before first contact is only caught by
  verifying.
- No forward secrecy.
- Envelopes aren't bound to time or sequence (replay within a conversation), and
  disappearing timers aren't signed.
- Async endpoints call the synchronous SQLite layer on the event loop — fine at
  family/team scale, a bottleneck beyond it.
- `GET /api/users?q=` returns avatars (up to 400 KB each, 25 results) — heavy on
  slow links.
- The Chrome extension requests `http://*/*` and `https://*/*` host permissions
  so it can reach any relay; narrowing that needs optional permissions per relay.

## Files changed

**Server:** `server/__init__.py`, `server/main.py`, `server/database.py`, `server/models.py`
**Client:** `client/js/app.js`, `client/js/crypto.js`, `client/index.html`,
`client/css/styles.css`, `client/manifest.json`
**Tests:** `scripts/db_test.py`, `scripts/regression_test.mjs`,
`scripts/ui_test_trust.mjs` (new); `scripts/run_all_tests.mjs`, `package.json`
**CI:** `.github/workflows/tests.yml` (new), the three installer workflows,
`docker-image.yml`
**Installer metadata:** `installer/lattix.iss`, `lattix.spec`, `version_info.txt`, `README.md`
**Docs:** `README.md`, `DEPLOYMENT.md`, `docs/reviews/` (this file; 2.1.1 review
moved here), and the wiki: API Reference, Architecture, Configuration,
Cryptography, Desktop Apps & Extension, Development & Contributing, FAQ,
Features, Home, Private Relay with Tailscale, Release Notes, Security & Trust
Model, Self-Hosting & Deployment, sidebar.
