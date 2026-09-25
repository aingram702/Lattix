# Cryptography

Everything here runs **in the browser** (or the desktop app's embedded browser).
The relay never sees plaintext, private keys, shared secrets, or file names.
Source: [`client/js/crypto.js`](https://github.com/aingram702/Lattix/blob/main/client/js/crypto.js).

## Primitives

| Purpose | Algorithm | Standard |
|---------|-----------|----------|
| Key encapsulation (confidentiality) | **ML-KEM-768** | FIPS 203 |
| Digital signatures (authenticity) | **ML-DSA-65** | FIPS 204 |
| Content encryption | **AES-256-GCM** | FIPS 197 / SP 800-38D |
| Key derivation (key wrapping) | **HKDF-SHA-256**, info `lattix-wrap-v1` | RFC 5869 |
| Safety code | **SHA-256**(KEM public ‖ DSA public) | FIPS 180-4 |
| Vault & encrypted backups | **PBKDF2-SHA-256**, 600,000 iterations + AES-256-GCM | SP 800-132 |

The post-quantum primitives come from the audited
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) 0.4.1,
vendored as one offline bundle (`client/vendor/lattix-pqc.js`, rebuilt by
`scripts/build_vendor.sh`). Symmetric crypto, hashing and PBKDF2 use the
browser's Web Crypto API. AES-256 keeps 128-bit strength against Grover's
algorithm, so the whole construction is post-quantum.

## Identity

A Lattix identity is two key pairs — **ML-KEM-768** (to receive wrapped content
keys) and **ML-DSA-65** (to sign what you send) — plus a random 32-byte
`auth_secret` used only to log in to the relay.

Only the public halves are published to the relay's directory. The relay
refuses a registration whose keys aren't exactly 1,184 and 1,952 bytes, or whose
`fingerprint` doesn't equal `SHA-256(kem_public ‖ dsa_public)`.

### Safety codes (fingerprints)

Your safety code is `SHA-256(kem_public ‖ dsa_public)`, shown as grouped hex.

**The client always computes a contact's code itself** from the keys it is
about to use (`fingerprintOf()`), and ignores the `fingerprint` field the relay
returns. Before 2.2 the app displayed the relay's field, which let a malicious
relay substitute keys while still showing the correct code. How codes are
pinned and verified is in [Security & Trust Model](Security-and-Trust-Model).

## The envelope scheme (messages)

1. Generate a fresh random 256-bit **Content Encryption Key (CEK)**.
2. Encrypt the message once: `AES-256-GCM(CEK, iv, plaintext)`.
3. For **each party** — every recipient **and** the sender:
   `ML-KEM-768.Encapsulate(their_kem_public) → (kem_ct, shared_secret)`,
   `KEK = HKDF-SHA-256(shared_secret, salt = ∅, info = "lattix-wrap-v1")`,
   `wrapped = AES-256-GCM(KEK, iv_k, CEK)`.
4. Build the **transcript**:
   `"msg" ‖ context ‖ iv ‖ ciphertext`, then for each party in sorted username
   order `username ‖ kem_ct ‖ iv_k ‖ wrapped`. Sign it with the sender's ML-DSA-65
   key.
5. The recipient rebuilds the transcript, verifies the signature against the
   sender's key, decapsulates its own `kem_ct`, unwraps the CEK and decrypts.

Wire payload: `{ iv, ciphertext, keys: { <username>: { kem_ct, iv, wrapped } }, signature }`
(all base64).

### Conversation binding

The transcript's **context** is empty for 1:1 chats (byte-compatible with 1.x)
and `g:<group_id>` for groups. A signed envelope therefore can't be replayed
into a *different* conversation. It is **not** bound to a time or sequence
number, so a hostile relay could re-deliver an old envelope within the same
conversation; the disappearing-message timer is also set by the relay, not
signed. Both are listed under known limitations.

## Files — format v2 (2.2+)

```
CEK        = random 256 bits
ciphertext = AES-256-GCM(CEK, iv,      file bytes)          → uploaded to /api/files
meta_ct    = AES-256-GCM(CEK, meta_iv, JSON{filename,mime,size})
ct_sha256  = SHA-256(ciphertext)
keys       = CEK wrapped per party, exactly as for messages
transcript = "lattix-file-v2" ‖ 0x00 ‖ context ‖ 0x00
             ‖ iv ‖ meta_iv ‖ ct_sha256 ‖ meta_ct ‖ per-party key material
payload    = { v: 2, iv, meta_iv, meta_ct, ct_sha256, keys, signature }
```

- **Names and types are encrypted.** The relay's file endpoints still require
  `filename` and `mime` fields; the 2.2 client sends the placeholders `"file"`
  and `application/octet-stream`. The real values are only in `meta_ct`.
- **The contents are signed.** Everyone a file is addressed to holds its CEK,
  so a signature over metadata alone (v1) let any recipient re-encrypt
  *different* bytes under the same CEK and IV — in a group, any member could
  swap a file under the sender's valid signature. v2 signs `ct_sha256`; the
  client hashes the downloaded blob and refuses it on mismatch **before**
  decrypting.
- **No downgrade.** The v2 transcript starts with a new domain prefix, so
  stripping a v2 payload into v1 shape yields a signature that does not verify.
- **On receipt** the client verifies the signature and decrypts `meta_ct`
  without downloading the file (`openFilePayload()`), so names show in the
  conversation immediately.

**Legacy v1 files** (2.1.x and earlier: plaintext `filename`/`mime`/`size` in
the payload, signature over metadata + keys only) are still read and decrypted.
A 2.1 client shows v2 files as unverified, so upgrade clients together.

## The vault and encrypted backups

```
key   = PBKDF2-SHA-256(password, random 16-byte salt, iter) → AES-256 key
vault = { v: 2, kdf: "pbkdf2-sha256", iter: 600000, salt, iv, ciphertext = AES-256-GCM(key, JSON(identity)) }
```

- `iter` is recorded in the file. Files without it (every vault and backup made
  before 2.2) open at **250,000** iterations.
- After a successful unlock or import of an older vault, the app **re-seals it
  at 600,000** in the background. The old vault stays in place if that fails.
- A file claiming fewer than 100,000 or more than 10,000,000 iterations is
  refused, so a tampered file can't hang the tab.
- **Encrypted backups** (chat history + settings) use the same construction with
  `kind: "backup"`.

600,000 matches OWASP's current guidance for PBKDF2-HMAC-SHA256. Choose a long
passphrase regardless: the vault file is only as strong as its password.

## What the relay stores vs. what it can read

| Stored on the relay | Readable by the relay? |
|----------------------|-------------------------|
| Usernames, public KEM/DSA keys, fingerprints, avatars | Yes — public by design |
| Message and file payloads (ciphertext, wrapped keys, signatures) | **No** |
| File names and MIME types (v2) | **No** — encrypted in `meta_ct` |
| Uploaded file blobs | **No** — AES-GCM ciphertext |
| File size (plaintext length) | Yes — sent as display metadata; the ciphertext length reveals it anyway |
| Group names, icons, rosters, owners | Yes |
| Who messaged whom, when, and envelope sizes | Yes |
| Password, private keys, vault | **Never sent** |
| `auth_secret` | Sent at login over TLS; stored only as a salted PBKDF2-SHA-256 hash (200k iterations) |

## Limitations

- **No forward secrecy / ratcheting.** Each message uses a fresh encapsulation,
  but a stolen long-term KEM secret key exposes past messages wrapped to it.
- **Replay within a conversation** and **unsigned expiry timers** (above).
- **Group membership changes aren't retroactive**: removed members keep what
  they received; new members can't read earlier history.

See [Security & Trust Model](Security-and-Trust-Model) for the threat model.
