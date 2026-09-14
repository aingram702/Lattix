# Cryptography

Everything here runs **in the browser**. The server never sees plaintext,
private keys, or shared secrets.

## Primitives

| Purpose | Algorithm | Standard |
|---------|-----------|----------|
| Key encapsulation (confidentiality) | **ML-KEM-768** (Kyber) | FIPS 203 |
| Digital signatures (authenticity) | **ML-DSA-65** (Dilithium) | FIPS 204 |
| Content encryption | **AES-256-GCM** | FIPS 197 / SP 800-38D |
| Key derivation | **HKDF-SHA-256** | RFC 5869 |
| Vault & encrypted backups | **PBKDF2-SHA-256** (250k iterations) + AES-256-GCM | — |

The post-quantum primitives come from the audited
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) library,
vendored as a single offline bundle (`client/vendor/lattix-pqc.js`). AES-256
stays safe against quantum adversaries — Grover's algorithm only halves its
effective strength to 128 bits — so the whole construction is post-quantum
secure.

## Identity

A Lattix identity is two key pairs:

- an **ML-KEM-768** key pair (for receiving wrapped content keys), and
- an **ML-DSA-65** key pair (for signing what you send).

Your **fingerprint** (a.k.a. safety code) is `SHA-256(kem_public || dsa_public)`,
shown grouped in hex. Two people comparing fingerprints out-of-band can be sure
they hold each other's real keys.

Only the **public** halves are uploaded to the directory. The private halves,
plus a random `auth_secret`, are sealed into your local vault.

## The envelope scheme

Whether it's a 1:1 chat or a group, the same scheme applies:

1. Generate a fresh random 256-bit **Content Encryption Key (CEK)**.
2. Encrypt the message (or file) **once** with AES-256-GCM under the CEK.
3. For **each party** — every recipient **and** the sender — perform an
   ML-KEM-768 encapsulation to their public key, run the shared secret through
   HKDF-SHA-256 (info `"lattix-wrap-v1"`) to a Key-Encryption-Key, and
   AES-GCM-**wrap** the CEK under it. Groups simply wrap the CEK for every
   member.
4. Build a **transcript** = a domain-separation prefix + IV + ciphertext + every
   party's wrapped-key material (usernames sorted), and **sign it** with the
   sender's ML-DSA-65 key.
5. The recipient recomputes the transcript, verifies the signature, decapsulates
   their wrapped key, unwraps the CEK, and decrypts.

Wrapping for the sender too is what lets you read your own sent history on any
device holding your vault.

### Conversation binding (replay protection)

The signed transcript's prefix includes a **context** string:

- empty for 1:1 chats (kept byte-compatible with earlier versions), and
- `g:<group_id>` for group messages.

Because the signature covers the context, a validly signed envelope **cannot be
replayed into a different conversation** — the signature won't verify there.

## Files

Files use the same scheme: the file bytes are AES-GCM encrypted under a CEK, the
CEK is wrapped per party, and a transcript over the file metadata
(`filename`, `mime`, `size`) + wrapped keys (+ context for groups) is signed.
The ciphertext is uploaded to `/api/files`; the signed key material rides in the
message envelope. Access to a blob is authorized server-side (uploader, a
sender/recipient of a message referencing it, or a member of a group that
referenced it) so file IDs aren't bearer capabilities.

## The vault (and encrypted backups)

Your identity is stored locally as an encrypted **vault**:

```
key   = PBKDF2-SHA-256(password, random 16-byte salt, 250_000 iters) → AES-256 key
vault = { salt, iv, AES-256-GCM( JSON(identity) ) }
```

**Encrypted backups** (chat history + settings) use the exact same construction.
Without the password, both are opaque ciphertext — they "cannot be stolen and
opened."

## What the server stores vs. what it can read

| Stored on the server | Can the server read it? |
|----------------------|-------------------------|
| Public KEM/DSA keys, fingerprints, usernames, avatars | Yes (they're public) |
| Message/file **payloads** (ciphertext, wrapped keys, signatures) | **No** |
| Uploaded file **blobs** | **No** (AES-GCM ciphertext) |
| Your password, private keys, vault | **Never sent to the server** |
| Auth secret | Sent at login over TLS; stored only as a salted PBKDF2 hash |

## Notes & limitations

- **No forward secrecy / ratcheting yet.** Identity keys are long-lived. Each
  message uses a fresh ephemeral KEM encapsulation, so compromising one
  message's transcript doesn't reveal others — but compromising a long-term KEM
  secret key exposes past messages wrapped to it. A Double-Ratchet-style upgrade
  is the natural next step.
- Group membership changes are not retroactive: removed members keep whatever
  they already received; new members can't read prior history.

See [Security & Trust Model](Security-and-Trust-Model) for the threat model.
