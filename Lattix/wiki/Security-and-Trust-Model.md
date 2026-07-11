# Security & Trust Model

Lattix is designed so the **server never needs to be trusted with your content.**

## What the relay can and cannot do

- ✅ It stores public keys, opaque ciphertext, and encrypted blobs.
- ❌ It **cannot read** your messages or files — it only ever sees ciphertext.
- ❌ It **cannot forge** messages — it holds no user's ML-DSA signing key;
  recipients verify every signature client-side, and signatures are bound to
  their conversation.
- ⚠️ The one thing a malicious server *could* attempt is **key substitution**
  (a man-in-the-middle): serving you the wrong public key for a contact.

## Defending against a malicious server: safety codes

Lattix defends against key substitution the same way Signal does — **fingerprint
verification**. Open a contact's **Verify** dialog and compare the safety code
with what they see on their device (in person, over a call, etc.). If the codes
match, you hold each other's real keys and the channel is authentic. This is the
step that turns "encrypted" into "encrypted *and* verified"; do it for contacts
that matter.

## Authentication is decoupled from encryption

The account login (a bearer token) only gates **who may push to the relay under
a username**. It is deliberately **not** the root of trust for message security:
even if login were bypassed, an attacker still couldn't read messages (they're
encrypted to recipients' KEM keys) or forge them (they lack the ML-DSA signing
key). Message security rests on the E2E keys and safety-code verification, not on
the token.

## Hardening already in place

- **HTTPS/WSS required** in any real deployment — the browser crypto needs a
  secure context and the login secret must travel over TLS.
- **Auth secrets** are stored only as **PBKDF2-SHA-256** hashes (200k iters,
  per-user salt), compared in constant time.
- **User-enumeration resistant login** — unknown users are hashed against a dummy
  salt so the response and timing don't reveal whether a username exists.
- **Per-IP rate limiting** on `/api/register` and `/api/login`.
- **Upload limits** — file uploads are bounded while streaming; message payloads
  are size-capped.
- **File-access checks** — a blob can only be fetched by its uploader or a
  sender/recipient/group-member of a message that references it (no IDOR).
- **Presence is scoped to contacts**, not broadcast to every user.
- **Non-root container**, single internal port, docs can be disabled in prod.

## Known limitations (be honest with yourself)

- **No forward secrecy / post-compromise security yet.** Long-lived identity
  keys mean a stolen KEM secret exposes past messages wrapped to it. (Each
  message still uses a fresh ephemeral encapsulation, limiting single-transcript
  compromise.) A ratchet is the planned upgrade.
- **Metadata is visible to the relay** — who talks to whom, and when. Content is
  not.
- **Single instance / in-memory state** — not built for horizontal scale (see
  [Architecture](Architecture)).
- **Not formally audited.** Lattix is a careful reference implementation, not a
  certified product. Get a professional review before trusting it with lives.

## Reporting a vulnerability

Please report security issues privately to the maintainer via the repository's
security advisory feature rather than opening a public issue.
