# Lattix Wiki

**Quantum-resistant, end-to-end encrypted chat & file sharing.**

Lattix is a from-scratch secure messenger. Every message and file is encrypted
**in your browser** using NIST post-quantum cryptography before it ever touches
the network. The server is a **zero-knowledge relay**: it only ever stores
public keys, opaque ciphertext, and encrypted blobs it cannot read — it can't
read your messages, and it can't forge them.

- **Repository:** https://github.com/aingram702/Lattix
- **License:** MIT

---

## What makes Lattix different

| | |
|---|---|
| 🔐 **Post-quantum by default** | ML-KEM-768 (FIPS 203) + ML-DSA-65 (FIPS 204) for every message and file. |
| 🕵️ **Zero-knowledge relay** | The server stores only ciphertext and public keys. A server compromise never reveals message content. |
| ✍️ **Authenticated** | Every envelope is signed; recipients verify it client-side. A 🔒 marks authentic messages. |
| 👨‍👩‍👧 **Groups** | Family/team group chats, E2E encrypted (the content key is wrapped per member). |
| ⏲️ **Disappearing messages** | Signal-style per-conversation timers, purged on client **and** server. |
| 🧩 **Everywhere** | Web app, Chrome extension, and standalone installers for Windows, macOS, and Linux. |
| 🌐 **No CDNs** | The whole frontend is dependency-free and works offline. |

---

## Start here

- **New user?** → [Getting Started](Getting-Started)
- **Want the full feature tour?** → [Features](Features)
- **Curious how it works?** → [Architecture](Architecture) · [Cryptography](Cryptography)
- **Running it for others?** → [Self-Hosting & Deployment](Self-Hosting-and-Deployment)
- **Building on the API?** → [API Reference](API-Reference)
- **Is it safe?** → [Security & Trust Model](Security-and-Trust-Model)

---

## The 60-second explanation

1. On your device, Lattix generates a **post-quantum identity** (a KEM key pair
   for confidentiality and a signature key pair for authenticity). Your private
   keys are sealed with your password into a local **vault** and never leave the
   device.
2. To send a message, the app generates a random 256-bit content key, encrypts
   the message once with AES-256-GCM, then **wraps** that content key separately
   for each recipient (and yourself) using a post-quantum key exchange. It signs
   the whole envelope.
3. The server stores and forwards that opaque envelope. It cannot unwrap any key
   or read any content.
4. The recipient verifies the signature, unwraps their copy of the content key,
   and decrypts.

To be sure the server didn't hand you the wrong public key for a contact
(a man-in-the-middle attempt), you compare **safety codes** out-of-band — the
same defense Signal uses.

See [Cryptography](Cryptography) for the full construction.

---

## Project status

Lattix is a solid, correct **reference implementation** — not a formally audited
product. It is a great way to learn how a post-quantum E2E messenger fits
together, and it is usable for real for small trusted groups. Get a professional
review before trusting it with lives. See
[Security & Trust Model](Security-and-Trust-Model) for the honest limitations.
