# Security & Trust Model

Lattix is designed so **the relay never needs to be trusted with your content** —
and, since 2.2, so that a relay that lies about keys gets caught.

## What the relay can and cannot do

- ✅ It stores public keys, opaque ciphertext, and encrypted blobs, and forwards them.
- ❌ It **cannot read** messages or files — including file names and types.
- ❌ It **cannot forge** messages or files — it holds no ML-DSA signing key,
  every signature is verified on the recipient's device, and signatures are
  bound to their conversation. File signatures cover the file contents.
- ⚠️ It **can attempt key substitution** — handing you its own public key in
  place of a contact's, so it can read what you send and re-sign what you
  receive. The defences below exist for exactly this.
- ⚠️ It **sees metadata**: who talks to whom and when, sizes, group names and
  rosters, avatars.

## Defending against key substitution

### 1. Safety codes are computed on your device

A safety code is `SHA-256(kem_public ‖ dsa_public)`. The app computes it from
the keys it is actually about to encrypt to and verify with. It never displays
or pins the `fingerprint` the relay reports.

> Before 2.2 the app displayed the relay's field. A relay could serve an
> attacker's keys alongside the victim's real code, and comparing codes would
> "succeed". See `docs/reviews/REVIEW-2.2.0.md`, finding 1.

### 2. Keys are pinned on first sight

The first key seen for each contact is **pinned** in this browser (per relay —
usernames are only unique within one). This is trust on first use, like SSH.
From then on:

| The contact's key changes and you had… | What happens |
|---|---|
| **not verified** them | The new key is pinned and a notice appears. You hadn't confirmed the old key either, so nothing stronger is lost. |
| **verified** them | Nothing is re-pinned. A **red banner** appears in the conversation, their new messages show ⚠ instead of 🔒, and **sending to them is paused** until you choose **Review** (compare the new code) or **Accept new code**. Accepting marks them unverified. |

In groups the same applies per member: a verified member with a changed key
pauses sending to the whole group, because every message is encrypted to them
too.

Keys are re-fetched when you open a conversation, when you open the Verify
dialog, and — for groups — every time you send, so a change is noticed straight
away rather than at the next reload.

### 3. Verify the contacts that matter

Any of these marks a contact **verified**:

- **Scan their QR code or open their share link.** Links look like
  `https://<relay>/#add=<username>&fp=<safety code>`. The link comes from the
  contact, not the relay, so it is an out-of-band copy of their code. On a
  match the contact is marked verified automatically. On a **mismatch** you get
  a warning, the red banner, and sending is paused.
- **Compare codes** in person or on a call using the **Verify** dialog, then
  click **Codes match — mark as verified**. The dialog also shows a verified
  contact's previous code if it changed.

### 4. The relay must publish your real keys

When you sign in, the app fetches your own directory entry and checks it
against the keys in your vault. If the relay is handing out different keys for
you, you are warned — contacts could be encrypting to someone else.

## Authentication is decoupled from encryption

The login token only gates **who may push to the relay under a username**. It is
not the root of trust for message security: even with a stolen token, an
attacker can't read messages (they're encrypted to KEM keys it doesn't hold) or
forge them (no ML-DSA key), and key substitution is caught by the pinning above.

## Hardening in place

- **HTTPS/WSS required** — browser crypto needs a secure context, and the login
  secret must travel over TLS. The app explains the problem when served over
  plain `http://` from a non-local address.
- **Directory integrity** — registrations must carry correctly sized keys and a
  matching fingerprint.
- **Auth secrets** are stored as salted PBKDF2-SHA-256 hashes (200k iterations)
  and compared in constant time; unknown usernames are hashed against a dummy
  salt so login timing doesn't reveal which accounts exist.
- **Per-IP rate limiting** on register and login (10 per 5 minutes by default).
- **Bounded inputs** — message payloads (2 MB), avatars (400 KB), file metadata,
  group rosters (256 validated usernames), disappearing timers (≤ 28 days),
  uploads (`LATTIX_MAX_FILE_MB`).
- **File access control** — a blob can only be fetched by its uploader, a
  party to a 1:1 message referencing it, or a current member of a group that
  referenced it; a file message may only reference a blob its sender uploaded.
- **Account deletion is complete** — tokens are revoked, open WebSockets closed,
  and group ownership handed on rather than deleting other people's groups.
- **Disappearing files** — a file message's blob is erased when it expires.
- **Presence** is visible only to contacts.
- **No link previews** — they would leak your IP to whoever sent the link.
  Inline image previews only render verified raster images (never SVG).
- **Session tokens** stay out of URLs and proxy logs (WebSocket auth is the
  first frame).
- **Non-root container**, one internal port, and API docs + schema can be
  switched off (`LATTIX_DOCS_URL=`).

## Known limitations

- **Trust on first use.** A relay that substitutes keys *before* you ever talk
  to someone is caught only when you verify them. Verify contacts that matter.
- **No forward secrecy / post-compromise security.** A stolen KEM secret key
  exposes past messages wrapped to it. A ratchet is the planned upgrade.
- **Replay within a conversation.** Signatures bind an envelope to its
  conversation, not to a time or sequence number; a hostile relay could
  re-deliver an old message in the same chat.
- **Disappearing timers are relay-enforced.** The TTL travels outside the
  signed envelope and each device deletes a message at the `expires_at` the
  relay reports, so a hostile relay could keep messages, or strip the timer.
- **Pins live in one browser.** A new device starts with no pins; verify again.
- **Metadata** is visible to the relay (above).
- **Single instance, in-memory state** — not horizontally scalable
  (see [Architecture](Architecture)).
- **Not formally audited.** Lattix is a careful reference implementation. Get a
  professional review before trusting it with lives.

## Reporting a vulnerability

Please report security issues privately through the repository's
**Security → Advisories** feature rather than a public issue.
