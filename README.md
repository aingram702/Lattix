<div align="center">

# Lattix

**Quantum-resistant chat & file sharing.**
End-to-end encrypted messaging built entirely on NIST post-quantum cryptography — with a clean, themeable, accessible single-page UI and one-click installers for Windows, macOS, and Linux.

**Version 2.0** · [What's new](#whats-new-in-20)

[![Windows installer](https://github.com/aingram702/Lattix/actions/workflows/build-windows-installer.yml/badge.svg)](https://github.com/aingram702/Lattix/actions/workflows/build-windows-installer.yml)
[![Linux installer](https://github.com/aingram702/Lattix/actions/workflows/build-linux-installer.yml/badge.svg)](https://github.com/aingram702/Lattix/actions/workflows/build-linux-installer.yml)
[![macOS installer](https://github.com/aingram702/Lattix/actions/workflows/build-macos-installer.yml/badge.svg)](https://github.com/aingram702/Lattix/actions/workflows/build-macos-installer.yml)

![Lattix conversation](docs/screenshots/app-dark.png)

</div>

Every message and file is encrypted **in your browser** before it ever touches the network. The server is a **zero-knowledge relay**: it stores public keys, opaque ciphertext, and encrypted blobs it cannot read. It can't read your messages, and it can't forge them — recipients verify a post-quantum signature on every message.

---

## Table of contents

- [What's new in 2.0](#whats-new-in-20)
- [Cryptography](#cryptography)
- [How a message is protected](#how-a-message-is-protected)
- [Features](#features)
- [Screenshots](#screenshots)
- [Get started](#get-started)
  - [Install (Windows / macOS / Linux)](#install-a-standalone-app)
  - [Run from source](#run-from-source)
  - [Chrome extension](#chrome-extension)
- [Host it (reachable from anywhere)](#host-it-reachable-from-anywhere)
- [Trust model](#trust-model)
- [Project layout](#project-layout)
- [Development](#development)
- [Security notes & limitations](#security-notes--limitations)
- [License](#license)

---

## Cryptography

| Purpose | Algorithm | Standard |
|--------|-----------|----------|
| Key encapsulation (confidentiality) | **ML-KEM-768** (Kyber) | FIPS 203 |
| Digital signatures (authenticity) | **ML-DSA-65** (Dilithium) | FIPS 204 |
| Content encryption | **AES-256-GCM** | FIPS 197 / SP 800-38D |
| Key derivation | **HKDF-SHA-256** | RFC 5869 |
| Vault & encrypted backups | **PBKDF2-SHA-256** (250k iters) + AES-256-GCM | — |

AES-256 remains safe against quantum adversaries — Grover's algorithm only halves its effective strength to 128 bits — so the whole construction is post-quantum secure. The PQC primitives come from the audited [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) library, vendored as a single offline bundle (`client/vendor/lattix-pqc.js`) — **no CDNs, works offline**.

## How a message is protected

Whether it's a 1:1 chat or a group, the same envelope scheme applies:

1. A fresh random 256-bit **Content Encryption Key (CEK)** is generated.
2. The message (or file) is AES-256-GCM encrypted **once** under the CEK.
3. For **each party** — every recipient **and** the sender — an ML-KEM-768 shared secret is established, run through HKDF to a Key-Encryption-Key, and used to AES-GCM-**wrap** the CEK. Groups simply wrap the CEK for every member.
4. The whole envelope (ciphertext + all wrapped keys) is **signed with the sender's ML-DSA-65 key**. The signature is **bound to the conversation** (e.g. the group id), so a signed envelope can't be replayed into a different conversation.
5. The recipient verifies the signature, decapsulates their wrapped key, unwraps the CEK, and decrypts.

Wrapping for the sender too means you can read your own sent history across devices.

---

## What's new in 2.0

Version 2.0 is a **usability, accessibility and performance release**. The
cryptography, the wire format, and the zero-knowledge guarantee are unchanged —
2.0 clients and 1.x histories are fully compatible — but almost every surface you
touch has been reworked.

**The conversation reads like a conversation.** Messages from one sender group
under a single header, days are separated, every bubble carries a timestamp, group
members get stable colors and avatars, links are clickable, and hovering a message
offers Copy and Quote. Received images decrypt and display inline (only when their
signature verified) with a click-to-zoom lightbox.

**Nothing gets lost.** Drafts are kept per conversation and survive reloads; a
failed send puts your text back in the box instead of dropping it; scrolling up no
longer gets yanked to the bottom by an arriving message.

**It's usable without a mouse, and with a screen reader.** ARIA roles and labels
throughout, a real focus trap and focus return in every dialog, a visible focus
ring, `prefers-reduced-motion` support, and shortcuts for the things you do
constantly. Every theme passes an automated axe-core WCAG 2.1 A/AA audit with no
serious or critical violations. The browser's `confirm()` and `prompt()` are gone.

**Creating an account is harder to get wrong.** A confirm-password field, a
strength meter, a Caps Lock warning, an explicit acknowledgement that the password
can't be recovered, and a warning before an existing vault is overwritten.

**It stays fast with a long history.** Renders are batched instead of running once
per arriving envelope, the message list renders a capped window with a *Load
earlier* button, boot work runs in parallel, and disappearing messages expire via
a single sweep rather than one timer per message.

**Plus:** a **System** theme that follows your OS live (applied before first paint,
so no flash of the wrong palette), conversation search, online presence dots, an
unread count in the tab title, drag-and-drop and clipboard-paste attachments,
size-checked *before* encryption, and WebSocket reconnect with exponential backoff.

Three small backwards-compatible relay changes support this: `/api/health` now
advertises `max_file_bytes`, and the relay sends a presence snapshot on connect and
refreshes presence on delivery.

Ten test suites and 234 assertions were added or extended along the way — see
[Development](#development). Six bugs turned up that weren't on the plan, four of
them pre-existing; the full write-up is in the wiki.

---

## Features

**Messaging**
- 🔐 **Post-quantum end-to-end encryption** for every message and file.
- 👨‍👩‍👧 **Group chats** — family or team groups, E2E encrypted (the CEK is wrapped per member). The relay still only ever sees ciphertext.
- 📎 **Encrypted file sharing** — files are encrypted client-side and stored as opaque blobs (up to 50 MB by default). **Drag a file onto the conversation** or **paste an image** straight from the clipboard; oversized files are rejected before they're encrypted, not after.
- 🖼️ **Inline image previews** — received images are decrypted and shown in the conversation with a click-to-zoom lightbox. Only ever applied to messages whose **signature verified**; a forged or tampered envelope stays an inert file card. Off by default (**Settings → Media**).
- ⚡ **Real-time delivery** over WebSocket, with offline queueing and automatic reconnect (exponential backoff).
- 🟢 **Presence** — a dot on each conversation shows who's online, including contacts who were already connected when you signed in.
- ⏲️ **Disappearing messages** — a Signal-style per-conversation timer (30 s → 1 week); expired messages are purged on both client and server.
- 🔔 **Notification tones & desktop alerts** — WebAudio send/receive tones and optional desktop notifications, plus an **unread count in the tab title** (no phone number or SMS — privacy-preserving by design).

**The conversation view** *(rebuilt in 2.0)*
- 🧵 **Message grouping** — consecutive messages from one sender collapse under a single header, with **date separators** between days and a timestamp on every bubble.
- 🎨 **Per-sender colors and avatars** in group chats, so you can tell who's talking at a glance.
- 🔗 **Linkified text**, and **Copy** / **Quote** actions on hover.
- ⤓ **Jump to latest** — a pill appears when you scroll up; new messages never yank you away from what you're reading.
- 📜 **Windowed history** — long conversations render a capped window with a **Load earlier** button instead of thousands of DOM nodes, and keep your scroll position when you expand it.
- ✏️ **Per-conversation drafts** — switching chats or reloading the page doesn't lose what you'd typed, and a failed send puts your text back in the box.

**Security & privacy**
- ✍️ **Signature verification** on every message — 🔒 marks authenticated messages, ⚠ marks failures.
- 🧾 **Key-fingerprint (safety-code) verification** — compare fingerprints out-of-band to defeat man-in-the-middle / key-substitution attacks.
- 🔗 **QR / link sharing** — a scannable QR code and share URL (offline QR generator, no CDN) that opens a *verified* conversation with you.
- 🛡️ **Account-creation guards** *(new in 2.0)* — confirm-password field, a live strength meter, a Caps Lock warning, an explicit acknowledgement that **your password cannot be recovered**, a warning before an existing vault is overwritten, and a nudge to take an encrypted backup on first run.
- 🚫 **Block users** — locally hide and ignore messages from specific accounts.
- 🗄️ **Encrypted local vault** — your private keys are sealed with your password (PBKDF2 + AES-GCM) and never leave the device.

**Accessibility & keyboard** *(new in 2.0)*
- ⌨️ **Fully keyboard-operable** — <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> new conversation, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> search, <kbd>/</kbd> to reach the message box, <kbd>Esc</kbd> to close. Every dialog traps focus and returns it where it came from.
- 🦮 **Screen-reader support** — ARIA roles, labels, and live regions throughout. Every theme passes an automated **axe-core WCAG 2.1 A/AA** audit with no serious or critical violations.
- 👁️ A visible **focus ring** on every control, and full **`prefers-reduced-motion`** support.
- 💬 **No browser `confirm()`/`prompt()`** anywhere — every confirmation is a real in-app dialog you can style, read, and dismiss.

**Personalization**
- 🎨 **Five theme choices** — **System** (follows your OS live), Light, Dark, Monokai, and a dark **Kali Linux** theme with the Kali dragon embedded. Your choice is applied **before first paint**, so there's no flash of the wrong palette on load.
- 🔎 **Conversation search** — filter the sidebar as you type.
- 🖌️ **Chat colors** — recolor your chat bubbles (red / green / blue / pink).
- 🖼️ **Profile images** — set an avatar so contacts can identify you (downscaled on-device).

**Data & portability**
- 📤 **Export chat history** as machine-readable JSON.
- 💾 **Encrypted backups** — password-sealed (PBKDF2 + AES-GCM) backup files that are useless without your password, plus one-click restore.
- 🧳 **Portable identity** — export/import your encrypted `.vault.json` to move to a new device.
- 🧨 **Delete application data** — one button resets the device (and account) to a fresh install.

**Platforms**
- 🖥️ **Standalone installers** for **Windows, macOS, and Linux** — bundle a Python runtime, no dependencies to install.
- 🧩 **Chrome extension** — the same client ships as an MV3 extension (no inline script; CSP-clean).
- 🌐 **Zero frontend dependencies** — no external CDNs, works offline.

## Screenshots

| Kali theme | Settings | Share / QR |
|------------|----------|------------|
| ![Kali theme](docs/screenshots/app-kali.png) | ![Settings](docs/screenshots/settings.png) | ![Share and QR](docs/screenshots/share-qr.png) |

---

## Get started

### Install a standalone app

Double-click installers that bundle everything — **no Python needed on the target machine**. Build them locally on the matching OS, or let CI build them for you (GitHub → **Actions** → the relevant workflow → **Run workflow**, then download the artifact; pushing a `v*` tag attaches installers to a Release).

| Platform | Artifact | How to build |
|----------|----------|--------------|
| **Windows** | `LattixSetup.exe` | `installer\build.bat` (needs [Inno Setup 6](https://jrsoftware.org/isdl.php)) |
| **macOS** | `Lattix-<ver>-<arch>.dmg` | `installer/macos/build.sh` |
| **Linux** | `Lattix-<ver>-<arch>.run` | `installer/linux/build.sh` |

See [`installer/README.md`](installer/README.md) for details. Launching Lattix starts a local relay on `http://localhost:8000` and opens it in your browser.

### Run from source

Requires **Python 3.10+**.

```bash
git clone https://github.com/aingram702/Lattix.git
cd Lattix

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python run.py                      # opens http://localhost:8000
```

Try it end-to-end by opening the app in **two different browsers** (or one normal + one private window), creating two accounts, and chatting. Each browser holds its own identity vault.

```bash
python run.py --reload                     # dev auto-reload
python run.py --no-browser                 # don't auto-open a browser
python run.py --port 9000                  # a different port
```

> **`--host 0.0.0.0` alone is not enough to share it.** Browsers expose
> `crypto.subtle` only in a *secure context* — HTTPS, or `http://` on
> `localhost` / `127.0.0.1`. Reached over plain `http://` at a LAN or public
> address, the sign-in page loads and then every action fails, because the
> browser has switched the crypto off. Lattix now says so instead of throwing.
>
> To use it from another machine, either serve it over HTTPS (see
> [Host it](#host-it-reachable-from-anywhere) — `deploy/vps/install-debian.sh`
> does Caddy + Let's Encrypt in one command), or forward the port and keep
> using `localhost`:
>
> ```bash
> ssh -N -L 8000:127.0.0.1:8000 user@your-server    # then open http://localhost:8000
> ```

### Chrome extension

The `client/` directory doubles as an unpacked MV3 extension:

1. Run a Lattix relay (`python run.py`, or install a standalone app).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `client/` folder.
3. Click the Lattix toolbar icon, then click **Change** next to *Relay: …* on the sign-in screen and point it at your server URL (default `http://localhost:8000`). Once signed in it's under **Settings → Relay server**.

All crypto still runs locally; the extension only talks to the relay you configure.

---

## Host it (reachable from anywhere)

To run Lattix as a public service over HTTPS so anyone can reach it, see **[DEPLOYMENT.md](DEPLOYMENT.md)**. It covers:

- A **one-command Debian VPS install** (OVHcloud or any provider) — hardened systemd service behind tuned Caddy or nginx configs with Let's Encrypt: [`deploy/vps/`](deploy/vps/README.md).
- A **one-command Docker Compose** setup with automatic HTTPS (Caddy + Let's Encrypt) and WSS for your own server or VPS.
- Managed platforms — **Render**, **Fly.io**, **Railway** — with persistent-volume and health-check config.
- A production [`Dockerfile`](Dockerfile) and a `docker-image` CI workflow that publishes a ready-to-deploy image to GHCR.

The desktop apps and the Chrome extension connect to a hosted relay from **Relay: … Change** on the sign-in screen or **Settings → Relay server** — with a built-in connection test.

HTTPS is **required** (browser crypto needs a secure context), and the relay runs as a **single instance** — sessions and real-time delivery are kept in memory, which is ideal for a family or team but not horizontally scaled.

---

## Trust model

Lattix is designed so the **server never needs to be trusted with your content**:

- It **cannot read** messages or files — it only ever sees ciphertext and public keys.
- It **cannot forge** messages — it holds no user's ML-DSA signing key; recipients verify every signature client-side, and signatures are bound to their conversation.
- Account login (the bearer token) only gates *who may push to the relay under a username*. It is deliberately **decoupled** from the E2E keys and is **not** the root of trust for message security.

The one thing a malicious server *could* attempt is a **key-substitution (MITM)** attack — serving you the wrong public key for a contact. Lattix defends against this the same way Signal does: **fingerprint verification**. Open a contact's **Verify** dialog and compare the safety code with what they see on their device (in person, over a call, etc.). If they match, the channel is authentic.

Blocking, disappearing-message timers, and profile images are conveniences layered on top of this core; they don't weaken it.

---

## Project layout

```
Lattix/                        # repository root (this is what you clone)
├── .github/workflows/         # CI that builds each OS installer
├── run.py                     # launcher (uvicorn wrapper)
├── requirements.txt
├── deploy/                    # Docker Compose + Caddy, Render, Fly, and vps/ (Debian install)
├── server/                    # zero-knowledge relay (FastAPI)
│   ├── main.py                #   REST + WebSocket + groups + static hosting
│   ├── database.py            #   SQLite: users, envelopes, groups, blobs
│   └── models.py              #   request/response schemas (payloads are opaque)
├── client/                    # single-page app (also the Chrome extension)
│   ├── index.html
│   ├── css/styles.css         #   themes: system / light / dark / monokai / kali
│   ├── js/
│   │   ├── app.js             #   UI + conversation/group logic
│   │   ├── crypto.js          #   E2E crypto (ML-KEM / ML-DSA / AES-GCM, backups)
│   │   ├── api.js             #   REST + WebSocket client (timeouts, re-login, heartbeat, resync)
│   │   ├── config.js          #   relay server setting (every build) + URL validation
│   │   ├── preload.js         #   applies the stored theme before first paint
│   │   ├── theme.js, sound.js #   appearance + notification tones
│   │   └── qr.js              #   offline QR-code generator
│   ├── vendor/lattix-pqc.js   #   bundled, offline post-quantum library
│   ├── icons/                 #   app + extension icons
│   ├── manifest.json          #   Chrome extension (MV3) manifest
│   └── background.js          #   extension service worker
├── installer/                 # standalone installers (all OSes)
│   ├── lattix_launcher.py     #   frozen entry point (starts relay, opens browser)
│   ├── lattix.spec            #   PyInstaller build (Win/mac/Linux)
│   ├── lattix.ico / .icns     #   Windows / macOS icons
│   ├── lattix.iss, build.ps1  #   Windows: Inno Setup -> LattixSetup.exe
│   ├── linux/                 #   Linux: self-extracting .run installer
│   └── macos/                 #   macOS: .dmg disk image
├── scripts/
│   ├── build_vendor.sh        #   rebuild the vendored crypto bundle
│   ├── run_all_tests.mjs      #   starts a scratch relay and runs every suite
│   ├── integration_test.mjs   #   full server + crypto end-to-end test
│   ├── server_test.mjs        #   relay rules: validation, authz, presence
│   ├── ui_test*.mjs           #   ten headless-browser UI suites (Playwright + axe)
│   └── lib/harness.mjs        #   shared signup/unlock test helpers
├── docs/screenshots/
└── data/                      # SQLite database (created at runtime)
```

CI workflows that build each OS installer live under
[`.github/workflows/`](.github/workflows/).

---

## Development

### Tests

Lattix ships **twelve suites, 310 assertions** — two that drive the real server
with the real crypto module, and ten browser suites that drive the real UI in
headless Chromium.

| Suite | Covers |
|---|---|
| `integration_test.mjs` | Protocol: registration, login, the key directory, encrypted messaging, plaintext-leak checks, sender self-decryption, tamper rejection, the encrypted-file round-trip, live WebSocket delivery. |
| `server_test.mjs` | Relay rules: directory input validation, file-blob access control, group ownership succession, presence across multiple sessions, session invalidation. |
| `ui_test.mjs` | Rendering, grouping, date separators, scroll anchoring, failed-send recovery. |
| `ui_test_media.mjs` | Encrypted image round-trip, previews, lightbox, group rendering. |
| `ui_test_a11y.mjs` | axe-core WCAG 2.1 A/AA over every theme, plus a keyboard-only walkthrough. |
| `ui_test_dialogs.mjs` | The in-app dialog controller, and a real encrypted backup/restore round-trip. |
| `ui_test_composer.mjs` | Drag-drop, clipboard paste, drafts, the send-busy lock. |
| `ui_test_sidebar.mjs` | Conversation filter, presence, unread title, reconnect backoff. |
| `ui_test_auth.mjs` | Signup guards, strength meter, vault-overwrite warning. |
| `ui_test_theme.mjs` | System theme, the anti-flash bootstrap, light-mode contrast. |
| `ui_test_perf.mjs` | Render batching, the render window, the expiry sweep. |
| `ui_test_relay.mjs` | Relay settings from sign-in and Settings, a remote relay from a cross-origin page, CORS/cache headers, first-frame WebSocket auth, restart with automatic re-login, missed-message resync, moving an identity. Starts its own relays; `LATTIX_PROXY_BASE` routes it through a reverse proxy. |

```bash
pip install -r requirements.txt
npm install && npx playwright install chromium

# everything, against a throwaway relay it starts and cleans up itself
node scripts/run_all_tests.mjs        # or: npm run test:all
```

To run one suite by hand, point it at a relay you started yourself:

```bash
LATTIX_DB=/tmp/lattix-test.db LATTIX_RATE_LIMIT_MAX=0 \
  python run.py --no-browser --port 8111 &
LATTIX_BASE=http://127.0.0.1:8111 node scripts/integration_test.mjs
```

> **`LATTIX_RATE_LIMIT_MAX=0` matters.** `/api/register` and `/api/login` are
> rate-limited per IP (10 attempts per 5 minutes by default) and the buckets
> live in the server process, so the suites — which create dozens of accounts
> from one address — otherwise start getting `429`. `run_all_tests.mjs` sets it
> for the relay it starts. Never set it on a public relay.

The browser suites assert *behaviour* — what the DOM actually does — rather than
screenshots, so they stay meaningful on a loaded CI box.

### Rebuilding the vendored crypto bundle

```bash
bash scripts/build_vendor.sh        # needs Node.js
```

---

## Security notes & limitations

- Run behind **HTTPS/WSS** in any real deployment — the account secret is sent to the server at login, and `crypto.subtle` requires a secure context off `localhost`.
- **No forward secrecy / ratcheting yet:** identity keys are long-lived (each message still uses a fresh ephemeral KEM encapsulation, so compromising one message's transcript doesn't reveal others, but compromising a long-term KEM secret key does expose past messages wrapped to it). A Double-Ratchet-style upgrade is the natural next step.
- **Profile images** are stored in the directory so contacts can see them, so they're not part of the zero-knowledge guarantee (everything else — message and file content — is).
- **Blocking** is enforced client-side (as in most E2E apps); a blocked user's server-side ability to send is unchanged, but you never see or get notified of their messages.
- This is a from-scratch application intended as a solid, correct reference — **not a formally audited product**. Get a professional review before trusting it with lives.

---

## License

MIT — see [LICENSE](LICENSE).
