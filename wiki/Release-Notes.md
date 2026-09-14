# Release Notes

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
