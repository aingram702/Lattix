# Features

A practical tour of everything Lattix does and how to use it. For *how* the
security features work, see [Cryptography](Cryptography) and
[Security & Trust Model](Security-and-Trust-Model).

## Messaging & files

- **Text messages** — type and press Enter (Shift+Enter for a newline). Every
  message is end-to-end encrypted and signed.
- **Encrypted files** — click the 📎 button. The file is encrypted in your
  browser and uploaded as an opaque blob (default max **50 MB**, configurable via
  `LATTIX_MAX_FILE_MB`). Recipients download and decrypt it locally.
- **Delivery** — messages arrive in real time over WebSocket when the recipient
  is online, and are queued on the server for delivery when they next connect.
- **Authenticity** — a 🔒 next to a message means its signature verified; a ⚠
  means it failed and the content should not be trusted.
- **Self-history** — messages are also wrapped for you, so you can read your own
  sent history on any device that holds your vault.

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
with your contact out-of-band (in person, over a call). Matching codes prove no
one substituted keys in the middle. This is the core anti-MITM defense.

## QR code / share link

Click the 🔗 button to open **Share my link**. It shows a scannable **QR code**
(generated fully offline — no CDN) and a copyable URL of the form
`https://your-server/#add=<username>&fp=<fingerprint>`. When someone opens that
link in their Lattix, it opens a conversation with you, pre-loaded for
safety-code verification.

## Profile images

**Settings → Profile → Upload image.** The picture is downscaled on-device and
shown across the UI so contacts can recognize you.

## Themes & chat colors

**Settings → Theme:** **Light**, **Dark**, **Monokai**, and a dark **Kali Linux**
theme (with the Kali dragon embedded). **Settings → Chat color:** recolor your
own chat bubbles — red, green, blue, or pink. Both preferences persist locally.

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

## Cross-platform

- **Web app** served by the relay.
- **Chrome extension** (same client, configurable server URL).
- **Desktop installers** for Windows, macOS, and Linux.

See [Desktop Apps & Extension](Desktop-Apps-and-Extension).
