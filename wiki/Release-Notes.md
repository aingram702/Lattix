# Release Notes

## 2.2.0

A **security release** from a full code review. Every finding was reproduced
against a live relay before it was fixed and now has a regression test; the
write-up is in [`docs/reviews/REVIEW-2.2.0.md`](https://github.com/aingram702/Lattix/blob/main/docs/reviews/REVIEW-2.2.0.md).

### Compatibility

- **Relay:** drop-in. The database migrates itself on start; 2.1 clients keep
  working against a 2.2 relay.
- **Clients:** a 2.2 client reads 2.1 history, vaults, backups and files. A 2.1
  client shows **files sent from 2.2 as unverified** (new file format), so
  update the desktop apps and extension alongside the relay. The web client
  updates with the relay.
- **API:** `/api/register` now refuses wrongly sized keys and a fingerprint that
  doesn't match the keys (`422`). Real clients are unaffected.

### Key trust

- **Safety codes are computed on your device.** The app used to display the
  fingerprint the relay *reported*, so a relay could swap a contact's keys and
  still show the correct code. It now hashes the keys it actually uses.
- **Key pinning.** The first key seen for each contact is pinned per relay. A
  change for an unverified contact re-pins with a notice. A change for a
  **verified** contact shows a red banner, marks their messages unverified, and
  **pauses sending** until you review or accept the new code.
- **Share links and QR codes verify.** Their `fp=` code was always there but
  ignored. A match now marks the contact verified; a mismatch warns and pauses
  sending.
- **Verify dialog** shows verified status, a previous code after a change, and a
  mark/unmark control.
- **Self-check** at sign-in: you're warned if the relay publishes keys for you
  that aren't the ones in your vault.

### Files (format v2)

- **Names, types and sizes are encrypted.** The relay stores placeholders.
- **Contents are signed.** The signature covers a SHA-256 of the ciphertext.
  Before, any recipient — in a group, any member — could re-encrypt different
  bytes under the file's key and have them pass the sender's signature.
- Downgrading a v2 payload to v1 shape fails verification. v1 files still open.

### Vault

- New vaults and backups use **PBKDF2-SHA-256 at 600,000 iterations** (was
  250,000), recorded in the file. Older vaults open as before and are re-sealed
  at the new strength after the next unlock. Absurd iteration counts from a
  tampered file are refused.

### Relay

- **Deleting a group owner's account no longer deletes the group** for every
  other member; ownership passes to the longest-standing member.
- **Long conversations load completely.** History was capped at 500 envelopes
  per request and the client never paged, so a reload showed only the oldest
  500 and the next live message hid the gap permanently. The client now pages;
  `/api/health` advertises `history_page_size`.
- **1.x databases start again.** An index on a migrated column was created
  before the migration added it ("no such column: file_id").
- **Deleted accounts are disconnected** (open WebSockets closed with 4401) and
  contacts see them go offline.
- **Expired disappearing files are erased immediately**, not up to 6 hours later.
- Racing registrations for one name return `409`, not `500`.
- Group rosters must be valid usernames.
- Binary WebSocket frames are ignored instead of raising.
- `LATTIX_DOCS_URL=` now hides the OpenAPI schema too (moved to
  `/api/openapi.json`); `/redoc` is no longer served.

### Operations & CI

- The installer and Docker workflows referenced a nonexistent `Lattix/`
  directory and failed; they now build from the repository root. Untagged
  installer builds take their version from `server/__init__.py`.
- New **Tests** workflow runs all 15 suites on every push and pull request.
- Docker backup instructions used `cp` on the live database, which can miss
  writes in SQLite's WAL; they now use SQLite's online backup.

### Tests

15 suites (up from 12): `db_test.py`, `regression_test.mjs` and
`ui_test_trust.mjs` are new.

## 2.1.1

A fix release for VPS deployments (review: [`docs/reviews/REVIEW-2.1.1.md`](https://github.com/aingram702/Lattix/blob/main/docs/reviews/REVIEW-2.1.1.md)).

- **Security:** a file message could reference someone else's blob and then
  download it as that message's sender (IDOR). File messages must now reference
  a blob their sender uploaded, and `payload.file_id` is forced to it.
- File metadata is bounded (`file_id` 32 hex chars, filename/MIME ≤ 255, size ≥ 0).
- The API-only `503` at `/` is plain text, as intended.
- `run.py` honours the VPS env file's `LATTIX_BIND` / `LATTIX_PORT`.
- `install-debian.sh`: checks AAAA records against the VPS's IPv6, stops
  apache2, refuses partial source trees, saves state before requesting the
  certificate.
- New read-only diagnostic: `deploy/vps/lattix-doctor.sh`.

## 2.1.0

A **remote-relay release**: choosing a relay is back in the interface for every
build, and the client and relay are tuned for running behind a reverse proxy on
a VPS. Cryptography, envelopes, vaults and backups are unchanged, and 2.1 clients
and relays interoperate with 2.0 and 1.x in both directions.

### Choosing a relay

- **Relay server settings for every build.** The setting used to exist only in
  the Chrome extension, so the web and desktop apps had no way to use another
  relay. It is now under **Settings → Relay server** everywhere.
- **Before signing in.** The sign-in screen shows which relay will be used and
  whether it's online, with a **Change** link — so a relay can be picked before
  an account exists or a vault is unlocked.
- **Validation as you type.** `chat.example.com` becomes `https://…`; a pasted
  `wss://…/ws` or `/api` URL is reduced to the relay base; plain `http://` over the
  internet warns; an `http://` relay from an `https://` page is refused (the
  browser would block it).
- **Test connection** checks that the relay answers, is a Lattix relay, and that
  WebSocket upgrades pass through the proxy — with a specific message for each
  way it can fail.
- **Moving to a new relay.** Unlocking an identity the relay doesn't know offers
  to register the same keys there. A username held by someone else is reported.
- **Fail fast.** Creating an account or unlocking checks the relay first,
  instead of spending seconds on key generation and then failing.
- **Share links and QR codes** point at the configured relay, not at a desktop
  app's private `localhost` address.

### Running through a proxy

- **Automatic re-login.** The relay keeps sessions in memory, so a restart —
  deploy, reboot — used to strand every open tab with `401`s and a WebSocket
  retrying a dead token forever. Clients now sign back in with the identity
  already unlocked, then retry. A 12-hour token expiry is handled the same way.
- **Nothing lost across reconnects.** Envelopes pushed while a socket was down
  were never delivered to that tab. After every reconnect the client now fetches
  what's newer than what it holds, including new contacts and groups.
- **Dead-socket detection.** The relay answers pings; a ping without a reply
  within 10 s drops the socket and reconnects. Catches connections silently
  killed by proxy idle timeouts, NAT or laptop sleep. Judged per ping, so a
  background tab's throttled timers aren't mistaken for an outage.
- **Faster recovery.** Jittered backoff, and an immediate reconnect when the
  network comes back or the tab becomes visible.
- **Session token out of URLs.** The WebSocket authenticates with its first frame
  instead of `?token=`, which reverse proxies write to their access logs. The
  query form still works for older clients.
- **Timeouts and retries.** 30 s per API call, 10 min per file transfer. Reads
  retry through the brief `502/503/504`s a proxy returns while the relay
  restarts; writes never retry, so a message can't be sent twice.
- **Readable errors** that name the relay instead of *Failed to fetch*.

### Relay changes

- **CORS for remote clients.** Desktop-app origins (`http://localhost:*`,
  `http://127.0.0.1:*`) and Chrome extension origins are allowed by default
  (`LATTIX_CORS_ALLOW_LOCAL=0` to turn off), with preflights cached for two hours.
  Safe without an allowlist of sites because there are no cookies to ride.
- **First-frame WebSocket auth**, `ready` and `pong` messages; bad tokens close
  with `4401` after accept, so clients can tell "re-login" from "proxy broken".
- **`/api/health` `features`** list.
- **Cache headers:** `no-store` on `/api/*`, `no-cache` on the static client.
- **Keep-alive** raised to 75 s (`LATTIX_KEEPALIVE`) in `run.py`, the container
  and the systemd unit, above the proxies' 60 s upstream keep-alive; `run.py`
  gains `--forwarded-allow-ips`. The container gets a `HEALTHCHECK`.

### Deployment

- **`deploy/vps/`** — one-command install on a Debian VPS (OVHcloud or any other):
  sandboxed systemd service on `127.0.0.1`, Caddy or nginx + certbot, `ufw`,
  idempotent `--update`. Tuned proxy configs: WebSocket timeouts, keep-alive
  ordering, retries during restarts (Caddy), WebSockets kept across reloads, body
  limit matched to `LATTIX_MAX_FILE_MB`, tokens stripped from access logs.
- The Docker Compose `Caddyfile` gets the same tuning.

### Tests

New `scripts/ui_test_relay.mjs` (48 assertions) starts two relays and restarts
one mid-run: CORS and cache headers, first-frame auth, the relay dialog from the
sign-in screen and Settings, a cross-origin desktop page on a remote relay, live
delivery, a relay restart with automatic re-login, a message missed while
offline, moving an identity, and an unreachable relay. Point it through a real
proxy with `LATTIX_PROXY_BASE`. All eleven suites pass directly and through both
the shipped Caddy and nginx configurations over HTTPS.

---

## 2.0.0

Version 2.0 is a **usability, accessibility and performance release**.

**The cryptography and the wire format are unchanged.** The envelope scheme, the
algorithms, the vault format, and the zero-knowledge guarantee are exactly as they
were in 1.x — a 2.0 client reads 1.x histories, 1.x vaults, and 1.x backups, and
2.0 and 1.x clients interoperate on the same relay. Nothing in this release
touches [Cryptography](Cryptography) or the
[Security & Trust Model](Security-and-Trust-Model). What changed is almost every
surface you actually touch.

### Upgrading

Nothing to do. Update the relay and reload the client. There is no database
migration, no vault re-encryption, and no re-registration — your keys, chats,
groups, and settings carry over untouched.

The relay's three new behaviours are backwards-compatible in both directions: an
old client ignores the new `/api/health` field, and a new client works against an
old relay (it falls back to the 50 MB default and simply shows nobody as online
until they connect).

---

### The conversation view

- **Message grouping.** Consecutive messages from the same sender within a few
  minutes collapse under one header instead of repeating it on every bubble.
- **Date separators** between days, and a timestamp on every message.
- **Per-sender colors and avatars** in group chats, derived stably from the
  username, so the same person is the same color for everyone.
- **Inline image previews** — received images are decrypted and shown in place,
  with a click-to-zoom lightbox. Applied **only** to messages whose ML-DSA
  signature verified; a forged or tampered envelope stays an inert file card you
  must opt into. Off by default, under **Settings → Media**.
- **Linkified text**, and **Copy** / **Quote** actions revealed on hover.
- **Jump to latest** — a pill appears when you've scrolled up. Arriving messages
  no longer drag you to the bottom mid-read.

### Nothing gets lost

- **Per-conversation drafts**, kept across conversation switches and page reloads.
  A conversation that has only a draft is rebuilt on boot, so it can't become
  unreachable.
- **A failed send puts your text back in the composer** instead of discarding it.
- **Scroll anchoring** — the view stays where you put it.

### Accessibility and keyboard

- **ARIA roles, labels, and live regions** throughout.
- **One modal controller** for every dialog: focus trap, <kbd>Esc</kbd> to close,
  and focus returned to whatever opened it.
- **Shortcuts** — <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> new conversation,
  <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> search, <kbd>/</kbd> to reach the
  message box, <kbd>Esc</kbd> to close. Listed in **Settings → Keyboard**.
- A visible **focus ring** on every control, and **`prefers-reduced-motion`**
  honoured throughout.
- **No `window.confirm` / `window.prompt` anywhere** — all four were replaced with
  real in-app dialogs that can be styled, labelled, and read by a screen reader.
- Every theme passes an automated **axe-core WCAG 2.1 A/AA** audit with no serious
  or critical violations.

### Account creation

- Confirm-password field, a live **strength meter**, and a **Caps Lock** warning.
- An explicit acknowledgement that **your password cannot be recovered**.
- A warning before an existing vault on the device is overwritten.
- A nudge to take an encrypted backup on first run.

### Sidebar and connectivity

- **Conversation search** — filter as you type.
- **Presence dots** showing who's online.
- **Unread count in the tab title**.
- **WebSocket reconnect with exponential backoff** instead of a fixed retry.

### Themes

- A **System** theme that follows your OS setting live, alongside Light, Dark,
  Monokai and Kali.
- The stored theme is applied **before first paint** (via a small external
  `js/preload.js` — MV3 forbids inline script), so there's no flash of the wrong
  palette on load.
- **Light-mode contrast pass** — three values were under WCAG AA and are fixed.
- `theme-color` and `color-scheme` track the applied palette.

### Composer

- **Drag a file onto the conversation** to attach it, or **paste an image**
  straight from the clipboard.
- Attachments are **size-checked before encryption**, using the new
  `max_file_bytes` from `/api/health`, rather than encrypting and then taking a
  `413`.
- A visible **send state**, so a slow send looks like a slow send.

### Performance

These matter once a conversation has thousands of messages in it.

- **Batched rendering** — renders coalesce into one animation frame instead of
  running once per arriving envelope. Boot replay of a long history was previously
  quadratic.
- **Windowed message list** — a capped number of bubbles render, with a **Load
  earlier** button that preserves scroll position.
- **Parallel boot** work.
- **One expiry sweep** for disappearing messages, replacing one timer per message.

### Relay changes

Three, all small and backwards-compatible:

- `GET /api/health` now advertises **`max_file_bytes`**.
- The relay sends a **presence snapshot on WebSocket connect**, so a client learns
  about contacts who are *already* online.
- **Delivery refreshes presence** for both parties — a first message is what makes
  two users contacts, and that produces no connect transition of its own.

See [API Reference](API-Reference).

### Tests

Nine headless-browser suites were added alongside the existing protocol suite:
**ten suites, 234 assertions**. They assert behaviour in a real browser — what the
DOM does, what axe-core reports, how many render passes a boot costs — rather than
comparing screenshots. See
[Development & Contributing](Development-and-Contributing).

### Bugs fixed that weren't on the plan

Six turned up during the work; each was found by a test rather than by reading.
Four were pre-existing:

1. **Panes never scrolled.** `.main` and `.sidebar` are grid items with the
   default `min-height: auto`, so they sized to their content and overflowed the
   viewport grid. `#messages` never scrolled at all and the composer was pushed
   off-screen in any conversation longer than one screen. It was masked because
   the old code ended with an unconditional `scrollTop = scrollHeight`, which is a
   silent no-op on a non-scrollable element.
2. **Theme labels were black on a dark surface** — about 1.1:1. `.choice` never
   set a `color` and fell back to the user agent's `buttontext`.
3. **Presence was only ever published on transitions**, so after a reload every
   contact showed as offline, and two users who became contacts while both online
   never saw each other.
4. **Three light-mode values were under WCAG AA** — measured, not eyeballed.

Two were introduced during the work and caught before shipping: drafts in a
never-sent conversation could be stranded, and the new dialog helper leaked a
pending promise when dismissed by <kbd>Esc</kbd> or a backdrop click.

---

## 1.1.0 and earlier

See the repository's commit history and releases.
