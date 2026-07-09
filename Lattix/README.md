# Lattix

**Quantum-resistant chat & file sharing.** End-to-end encrypted messaging and file transfer built entirely on NIST post-quantum cryptography — with a clean, dark, single-page UI.

Every message and file is encrypted **in your browser** before it ever touches the network. The server is a zero-knowledge relay: it stores public keys, opaque ciphertext, and encrypted blobs it cannot read.

---

## Cryptography

| Purpose | Algorithm | Standard |
|--------|-----------|----------|
| Key encapsulation (confidentiality) | **ML-KEM-768** (Kyber) | FIPS 203 |
| Digital signatures (authenticity) | **ML-DSA-65** (Dilithium) | FIPS 204 |
| Content encryption | **AES-256-GCM** | FIPS 197 / SP 800-38D |
| Key derivation | **HKDF-SHA-256** | RFC 5869 |
| Vault protection | **PBKDF2-SHA-256** (250k iters) + AES-256-GCM | — |

AES-256 remains safe against quantum adversaries — Grover's algorithm only halves its effective strength to 128 bits — so the whole construction is post-quantum secure. The PQC primitives come from the audited [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) library, vendored as a single offline bundle (`client/vendor/lattix-pqc.js`).

### How a message is protected

1. A fresh random 256-bit **Content Encryption Key (CEK)** is generated.
2. The message is AES-256-GCM encrypted once under the CEK.
3. For each party (recipient **and** sender), an ML-KEM-768 shared secret is established, run through HKDF to a Key-Encryption-Key, and used to AES-GCM-**wrap** the CEK.
4. The whole envelope (ciphertext + all wrapped keys) is **signed with the sender's ML-DSA-65 key**.
5. The recipient verifies the signature, decapsulates their wrapped key, unwraps the CEK, and decrypts.

Wrapping for the sender too means you can read your own sent history across devices.

---

## Features

- **Post-quantum end-to-end encryption** for every message and file.
- **Group chats** — create family/team groups. The content key is wrapped per member, so groups are E2E encrypted too and the relay still only sees ciphertext. Signatures are bound to the group, so an envelope can't be replayed into another conversation.
- **Encrypted file sharing** — files are encrypted client-side and stored as opaque blobs (up to 50 MB by default).
- **Real-time delivery** over WebSocket, with offline message queueing.
- **Signature verification** on every message — a 🔒 marks authenticated messages, ⚠ marks failures.
- **Key-fingerprint verification** — compare fingerprints out-of-band to defeat man-in-the-middle / key-substitution attacks.
- **Profile images** — set a small avatar so contacts can identify you (downscaled on-device, stored in the directory).
- **Disappearing messages** — a Signal-style per-conversation timer (30 s → 1 week). Expired messages are dropped on both client and server.
- **Block users** — locally hide and ignore messages from specific accounts.
- **QR / link sharing** — generate a scannable QR code and share URL (offline QR generator, no CDN) that opens a verified conversation with you.
- **Themes** — Light, Dark, Monokai, and a dark **Kali Linux** theme with the Kali dragon embedded.
- **Chat colors** — recolor your chat bubbles (red / green / blue / pink).
- **Notification tones + desktop alerts** — WebAudio send/receive tones and optional in-app desktop notifications (no phone number or SMS — privacy-preserving by design).
- **Export & backup** — export a machine-readable JSON of your chat history, or save a **password-encrypted backup** (PBKDF2 + AES-GCM) that's useless without your password.
- **Delete application data** — one button resets the device (and account) to a fresh install.
- **Encrypted local vault** — your private keys are sealed with your password (PBKDF2 + AES-GCM) and never leave the device.
- **Portable identity** — export/import your encrypted `.vault.json` to move to a new device.
- **Chrome extension** — the same client ships as a Chrome (MV3) extension (see below).
- **Zero frontend dependencies** — no external CDNs, works offline.

---

## Chrome extension

The `client/` directory doubles as an unpacked MV3 extension (one codebase — the
same files the relay serves):

1. Run a Lattix relay somewhere reachable (`python run.py`).
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select the `client/` folder.
3. Click the Lattix toolbar icon — it opens the app in a tab. Open
   **Settings → Relay server** and point it at your server URL
   (default `http://localhost:8000`).

The extension is a thin shell: all crypto still runs locally and it talks only
to the relay you configure.

---

## Quick start

Requires **Python 3.10+**.

```bash
git clone https://github.com/aingram702/Lattix.git
cd Lattix

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python run.py                      # opens http://localhost:8000
```

Then, to try it end-to-end, open the app in **two different browsers** (or one normal + one private window), create two accounts, and start chatting. Each browser holds its own identity vault.

Options:

```bash
python run.py --host 0.0.0.0 --port 9000   # expose on your LAN
python run.py --reload                     # dev auto-reload
python run.py --no-browser                 # don't auto-open a browser
```

---

## Project layout

```
Lattix/
├── run.py                    # launcher (uvicorn wrapper)
├── requirements.txt
├── server/                   # zero-knowledge relay (FastAPI)
│   ├── main.py               #   REST + WebSocket + static hosting
│   ├── database.py           #   SQLite: keys, envelopes, encrypted blobs
│   └── models.py             #   request/response schemas (payloads are opaque)
├── client/                   # single-page app (served by the server)
│   ├── index.html
│   ├── css/styles.css        #   dark theme
│   ├── js/
│   │   ├── app.js            #   UI logic
│   │   ├── crypto.js         #   all E2E crypto (ML-KEM / ML-DSA / AES-GCM)
│   │   └── api.js            #   REST + WebSocket client
│   └── vendor/
│       └── lattix-pqc.js     #   bundled, offline post-quantum library
├── scripts/
│   ├── build_vendor.sh       #   rebuild the vendored crypto bundle
│   └── integration_test.mjs  #   full server + crypto end-to-end test
└── data/                     # SQLite database (created at runtime)
```

---

## Trust model

Lattix is designed so the **server never needs to be trusted with your content**:

- It **cannot read** messages or files — it only ever sees ciphertext and public keys.
- It **cannot forge** messages — it holds no user's ML-DSA signing key; recipients verify every signature client-side.
- Account login (the bearer token) only gates *who may push to the relay under a username*. It is deliberately **decoupled** from the E2E keys and is **not** the root of trust for message security.

The one thing a malicious server *could* attempt is a **key-substitution (MITM)** attack — serving you the wrong public key for a contact. Lattix defends against this the same way Signal does: **fingerprint verification**. Open a contact's **Verify keys** dialog and compare the fingerprint with what they see on their device (in person, over a call, etc.). If they match, the channel is authentic.

### Security notes / limitations

- Run behind **HTTPS/WSS** in any real deployment — the account secret is sent to the server at login, and `crypto.subtle` requires a secure context off `localhost`.
- No forward secrecy / ratcheting yet: identity keys are long-lived (each message still uses a fresh ephemeral KEM encapsulation, so compromising one message's transcript doesn't reveal others, but compromising a long-term KEM secret key does expose past messages wrapped to it). A Double-Ratchet-style upgrade is the natural next step.
- This is a from-scratch application intended as a solid, correct reference — not a formally audited product. Get a professional review before trusting it with lives.

---

## Development

Run the full end-to-end test suite (starts nothing itself — point it at a running server):

```bash
# terminal 1
python run.py --no-browser --port 8111
# terminal 2
node scripts/integration_test.mjs        # uses LATTIX_BASE, defaults to :8111
```

It exercises registration, login, the key directory, encrypted messaging, plaintext-leak checks, sender self-decryption, tamper rejection, the encrypted-file round-trip, and live WebSocket delivery — all against the real server using the real client crypto module.

Rebuild the vendored post-quantum bundle (needs Node.js):

```bash
bash scripts/build_vendor.sh
```

---

## License

MIT — see [LICENSE](LICENSE).
