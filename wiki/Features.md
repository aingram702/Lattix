# Features

A practical tour of everything Lattix does and how to use it. For *how* the
security features work, see [Cryptography](Cryptography) and
[Security & Trust Model](Security-and-Trust-Model).

## Messaging & files

- **Text messages** — type and press Enter (Shift+Enter for a newline). Every
  message is end-to-end encrypted and signed.
- **Encrypted files** — click the 📎 button, **drag a file onto the
  conversation**, or **paste an image** from the clipboard. The file is encrypted
  in your browser and uploaded as an opaque blob (default max **50 MB**,
  configurable via `LATTIX_MAX_FILE_MB`). Recipients download and decrypt it
  locally. Oversized files are rejected *before* they're encrypted — the client
  reads the relay's limit from `/api/health` at boot.
- **Inline image previews** — received images are decrypted and displayed in the
  conversation, and click to open a full-size lightbox. This is applied **only to
  messages whose signature verified**: a forged or tampered envelope stays an
  inert file card you have to open deliberately. On by default; turn it off
  under **Settings → Media → Show images inline**. SVG is never previewed.
- **Private file names** (2.2) — a file's name, type and size are encrypted with
  it; the relay only ever stores placeholders. The sender's signature covers the
  file's contents, so nobody else who received it can swap the bytes.
- **Delivery** — messages arrive in real time over WebSocket when the recipient
  is online, and are queued on the server for delivery when they next connect. If
  the socket drops, the client reconnects with exponential backoff.
- **Authenticity** — a 🔒 next to a message means its signature verified; a ⚠
  means it failed and the content should not be trusted.
- **Self-history** — messages are also wrapped for you, so you can read your own
  sent history on any device that holds your vault.

## Reading a conversation

- **Grouping** — consecutive messages from one sender collapse under a single
  header rather than repeating it, with **date separators** between days and a
  timestamp on every message.
- **Sender colors & avatars** — in a group, each member gets a stable color and
  avatar derived from their username, so the same person looks the same to
  everyone.
- **Links** are clickable. Hovering a message reveals **Copy** and **Quote**
  (quoting drops the text into the composer prefixed with `>`).
- **Jump to latest** — scroll up and a pill appears; arriving messages won't drag
  you back down mid-read. Click it to return to the bottom.
- **Long histories** render a capped window with a **Load earlier** button. Your
  scroll position is preserved when you expand it, and nothing is dropped from
  memory — only from the DOM.

## Drafts

Anything you've typed but not sent is kept **per conversation**. Switch chats,
close the tab, come back tomorrow — it's still there, and the conversation shows
an ✏️ preview in the sidebar. If a send fails, your text goes back into the
composer rather than disappearing.

## Search & presence

- **Conversation search** — the box above the conversation list filters as you
  type (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd>).
- **Presence** — a dot shows which contacts are online right now, including ones
  who were already connected when you signed in.
- **Unread count** — the number of unread messages appears in the browser tab
  title, so a background tab still tells you something arrived.

## Group chats

Create a group for a family or a team. Click **👥 New group**, give it a name and
optional emoji icon, and add members.

- Messages and files are E2E encrypted: the content key is wrapped for **every
  member**, so the relay still only sees ciphertext.
- Signatures are **bound to the group**, so a signed envelope can't be replayed
  into another conversation.
- **Group info** (the header menu) shows members. The **owner** can add or
  remove members; any member can **leave**.
- New members can't read history from before they joined (it was never wrapped
  for them).

## Disappearing messages

Open a conversation's header menu → **Disappearing messages** and pick a timer
(Off, 30 s, 5 min, 1 hour, 1 day, 1 week). New messages you send carry that
lifetime; they're removed from the UI when it elapses and **purged from the
server** by a background sweep, so they don't reappear on reload.

## Blocking users

Header menu → **Block user**. Blocked users are hidden from your contact list and
their incoming messages are ignored. Manage the block list in **Settings →
Blocked users**. Blocking is enforced on your device.

## Safety-code verification

Header **Verify** button (or **Settings** for your own code). Compare the code
with your contact out-of-band (in person, over a call) and click **Codes match —
mark as verified**. Matching codes prove no one substituted keys in the middle.
This is the core anti-MITM defense.

The code is computed on your device from the keys actually in use, never taken
from the relay (2.2). The first key seen for each contact is pinned.

## Key-change banner

If a contact you **verified** gets a different key — a reinstall, a new device,
or a relay substituting keys — a red banner appears in the conversation. Their
new messages show ⚠ instead of 🔒 and **sending to them pauses** until you choose
**Review** (compare the new code) or **Accept new code** (which marks them
unverified). An unverified contact's new key is simply re-pinned with a notice.
In a group, one verified member with a changed key pauses sending to the group.

## QR code / share link

Click the 🔗 button to open **Share my link**. It shows a scannable **QR code**
(generated fully offline — no CDN) and a copyable URL of the form
`https://your-server/#add=<username>&fp=<fingerprint>`. When someone opens that
link in their Lattix, it opens a conversation with you and **checks the code in
the link against the keys the relay serves**: a match marks you verified on
their side automatically; a mismatch warns them and pauses sending.

## Profile images

**Settings → Profile → Upload image.** The picture is downscaled on-device and
shown across the UI so contacts can recognize you.

## Themes & chat colors

**Settings → Theme:** **System**, **Light**, **Dark**, **Monokai**, and a dark
**Kali Linux** theme (with the Kali dragon embedded).

**System** follows your operating system's light/dark setting and switches live
when you change it — no reload needed. Picking any other theme explicitly stops
it following the OS. Whichever you choose is applied **before the first paint**,
so the page never flashes the wrong palette on load.

**Settings → Chat color:** recolor your own chat bubbles — red, green, blue, or
pink. Both preferences persist locally.

## Notifications

**Settings → Notifications:**

- **Message tones** — short WebAudio blips on send/receive (no audio files).
- **Desktop alerts** — optional browser notifications for incoming messages
  while the app is in the background.

> Lattix deliberately has **no SMS / phone-number** notifications — that would
> require storing phone numbers and leaking metadata, breaking the
> zero-knowledge model.

## Data: export, backup, restore, delete

- **Export chat history (JSON)** — a machine-readable, plaintext export of your
  decrypted conversations (your data, on your device).
- **Encrypted backup** — a password-sealed backup file (PBKDF2 + AES-256-GCM) of
  your chats and settings. Useless to anyone without the password.
- **Restore backup** — import an encrypted backup with its password.
- **Export vault** — save your encrypted `.vault.json` identity to move to
  another device (import it from the welcome screen).
- **Delete application data** — wipes this device's keys, chats, and settings and
  deletes your server account, resetting Lattix to a fresh install. Irreversible.

## Accessibility & keyboard

Lattix is fully operable without a mouse, and every theme passes an automated
**axe-core WCAG 2.1 A/AA** audit with no serious or critical violations.

| Shortcut | Does |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> | New conversation |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> | Search conversations |
| <kbd>/</kbd> | Jump to the message box |
| <kbd>Enter</kbd> | Send (<kbd>Shift</kbd>+<kbd>Enter</kbd> for a newline) |
| <kbd>Esc</kbd> | Close the open dialog or menu |

The same list is in **Settings → Keyboard**.

- Every dialog **traps focus** while open and **returns focus** to whatever opened
  it when closed.
- Controls carry ARIA roles and labels, and status changes are announced through
  live regions.
- There's a visible **focus ring** on every focusable control, and
  **`prefers-reduced-motion`** is honoured throughout.
- Lattix never uses the browser's `confirm()` or `prompt()` — every confirmation
  is a real in-app dialog, which means it can be labelled, read aloud, and
  dismissed with <kbd>Esc</kbd>.

## Creating an account safely

Your password seals a vault that **cannot be recovered**, so the signup form works
to stop a typo becoming a lost identity:

- A **confirm-password** field.
- A live **strength meter**.
- A **Caps Lock** warning.
- An explicit **acknowledgement** that the password can't be recovered.
- A **warning before overwriting** a vault that already exists on the device.
- A nudge to take an **encrypted backup** on first run.

## Cross-platform

- **Web app** served by the relay.
- **Chrome extension** (same client, configurable server URL).
- **Desktop installers** for Windows, macOS, and Linux.

See [Desktop Apps & Extension](Desktop-Apps-and-Extension).
