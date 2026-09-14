# Phase 1 — Chat surface polish (working brief)

Branch: `ux/phase-1-chat-surface` (branched from `ux/phase-0-correctness`)

Phase 0 is merged into this branch and the enabling refactors are already
landed. This brief is the delta: what's ready, what's left, and the code that
changed since the original plan was written.

---

## What Phase 0 prep already landed on this branch

These are behaviour-neutral. They exist so the Phase 1 edits are small.

| Refactor | Where | Why Phase 1 needs it |
|---|---|---|
| `renderMessages()` loop is indexed, exposes `prev` | `app.js` | Message grouping needs the previous message |
| `sameRun` computed, emitted as `.row.same` | `app.js` | The class is live but **unstyled** — Phase 1 adds the CSS |
| `fetchDecryptedFile(m)` split out of `downloadFile(m)` | `app.js` | Inline image previews reuse the decrypt path |
| `releaseObjectUrls(messages)` + wired into expiry | `app.js` | Stops preview blobs leaking for the tab's lifetime |
| `scripts/ui_test.mjs` (23 assertions) | `scripts/` | Regression net — run it after every Phase 1 step |

`sameRun` is currently: same sender, same day, neither is an error, and within
300 s of the previous message. Tune that window in one place if it feels wrong.

---

## Corrections to the original plan

The plan was written before Phase 0. Three snippets in it are now stale:

1. **`renderMessages()` takes `{ force }`.** Any Phase 1 code that calls it must
   use `renderMessages({ force: true })` when the user just acted, and bare
   `renderMessages()` when reacting to an inbound envelope. Getting this wrong
   re-breaks the scroll anchoring that Phase 0 fixed.

2. **`.msg-meta` already moved to 11px / `.78` opacity** (the plan listed that
   under Phase 4). Don't re-apply it.

3. **The `.bubble` flex rewrite in §1.1 must preserve `.unverified-msg`.**
   Phase 0 added a border + inset box-shadow to that class. The plan's
   replacement `.bubble` rule drops `border` from the base selector, which is
   fine, but verify the unverified border still renders after the flex change —
   `scripts/ui_test.mjs` asserts the glyph colour, not the border, so add an
   assertion for it.

---

## Order of work

Each step is independently shippable and independently testable.

### 1. Bubble flex + meta inline (§1.1)
Lowest risk, highest visible payoff. Pure CSS. Watch the file card and the
group sender label — both need `flex` hints so they don't collapse.

**Verify:** short message puts the timestamp on the same line; a 200-char
message pushes it to its own trailing line; the unverified border survives.

### 2. Message grouping (§1.2)
CSS only — the JS already emits `.row.same`.

**Verify:** three messages 10 s apart collapse; the same three 10 min apart do
not; a day boundary always breaks the run.

### 3. Group sender colour + avatars (§1.3)
Needs `--sender-l` per theme. The avatar goes in the `.row`, outside the
bubble, so `.row.left` needs `align-items: flex-end` and the spacer variant.

**Verify:** in a 3-person group, three distinct label colours; avatars align to
the bubble's bottom edge; `.same` runs show a hidden spacer, not a repeat.

### 4. Inline image previews (§1.4)
The largest piece. `fetchDecryptedFile` and `releaseObjectUrls` are ready.

**Security rule — do not relax:** preview only when `m.verified` is true. An
unverified attachment stays a plain file card with a Download button, so a
forged or tampered envelope can never auto-render media in the reader's view.
Cap auto-preview at 8 MB and restrict to
`png|jpeg|gif|webp|avif` — no SVG (scriptable).

Also add the `#toggle-autoimg` switch and persist `lattix.autoImages`.

**Verify:** PNG/GIF preview; a 200 MB MP4 stays a file card; an envelope with a
broken signature offers no preview; `releaseObjectUrls` runs when a
disappearing image expires (check `performance.memory` or just assert
`_objectUrl === null`).

### 5. Linkified message text (§1.5)
Escape first, then linkify the escaped string. Keep `rel="noopener noreferrer
nofollow"`. No link previews — fetching a URL would leak the reader's IP and
the fact they opened the message to a third party.

**Verify:** a URL containing `&` and one wrapped in parentheses both linkify
correctly; `<script>` in message text stays inert.

### 6. Hover actions (§1.6)
Copy + quote only. Both are client-side; neither touches the protocol.

**Verify:** actions appear on hover and on `:focus-within`; on a touch viewport
they are always visible; `.row.right` puts them on the inside edge.

### 7. Empty state actions (§1.7)
Two buttons, existing handlers.

---

## Out of scope for Phase 1

Threaded replies, reactions, read receipts, typing indicators and unsend all
change what goes inside the encrypted plaintext or need new relay endpoints.
They need a `v` field in the message body and a compatibility story. See
"Later (needs a protocol bump)" in the main plan.

---

## Running the tests

```bash
# terminal 1 — relay on a throwaway db
pip install -r requirements.txt
LATTIX_DB=/tmp/lattix-test.db python -m uvicorn server.main:app --port 8111

# terminal 2
node scripts/integration_test.mjs        # protocol: 11 assertions
node scripts/ui_test.mjs                 # rendered UI: 23 assertions
```

`ui_test.mjs` needs `npm i -D playwright && npx playwright install chromium`,
or set `PW_CHROMIUM` to an existing Chromium binary.

**Note:** `/api/register` is rate-limited per IP. A few consecutive UI runs will
start returning 429 — restart the relay to clear the in-memory buckets, since
they are process state, not database state.
