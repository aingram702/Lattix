# Getting Started

There are three ways to use Lattix. All of them run the same crypto locally and
talk to a Lattix **relay server** (which you or someone else hosts).

- [A. Run from source](#a-run-from-source) — quickest for trying it out.
- [B. Standalone desktop app](#b-standalone-desktop-app) — double-click install, no Python.
- [C. Chrome extension](#c-chrome-extension) — a toolbar button that opens the app.

> **Heads-up:** off `localhost`, Lattix **requires HTTPS**. Browsers only expose
> the Web Crypto API in a secure context, so a public deployment must be served
> over `https://`. See [Self-Hosting & Deployment](Self-Hosting-and-Deployment).

---

## A. Run from source

Requires **Python 3.10+**.

```bash
git clone https://github.com/aingram702/Lattix.git
cd Lattix/Lattix                   # the app lives in the repo's Lattix/ subfolder

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python run.py                      # opens http://localhost:8000
```

Useful flags:

```bash
python run.py --host 0.0.0.0 --port 9000   # expose on your LAN
python run.py --reload                     # dev auto-reload
python run.py --no-browser                 # don't auto-open a browser
```

To try it end-to-end, open the app in **two different browsers** (or one normal
+ one private window), create two accounts, and start chatting — each browser
holds its own identity vault.

---

## B. Standalone desktop app

Double-click installers bundle a Python runtime — **nothing to install** on the
target machine. Launching Lattix starts a local relay on `http://localhost:8000`
and opens it in your browser.

| Platform | Artifact |
|----------|----------|
| Windows  | `LattixSetup.exe` |
| macOS    | `Lattix-<ver>-<arch>.dmg` |
| Linux    | `Lattix-<ver>-<arch>.run` |

Get them from the repo's **Actions** tab (run the matching build workflow and
download the artifact), from a tagged **Release**, or build locally. See
[Desktop Apps & Extension](Desktop-Apps-and-Extension).

---

## C. Chrome extension

The `client/` folder is also a Chrome MV3 extension.

1. Run a Lattix relay somewhere (`python run.py`, an installer, or a deployment).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select the `client/` folder.
3. Click the Lattix toolbar icon, then **Settings → Relay server** and point it
   at your server URL (default `http://localhost:8000`).

See [Desktop Apps & Extension](Desktop-Apps-and-Extension) for details.

---

## First run: creating your identity

1. **Create account** — pick a username and a password. Lattix generates your
   post-quantum keys on-device and seals them into an encrypted **vault** with
   your password. The server only receives your *public* keys.
   > Your password cannot be recovered. If you lose it, you lose the vault on
   > that device — export a backup (below) to be safe.
2. **Unlock** — on a device that already has a vault, you just enter your
   password.
3. **Import a vault** — move your identity to a new device with an exported
   `.vault.json` file (Settings → Export vault).

## Starting a conversation

- **New chat:** click **+ New chat**, search a username, and message them.
- **New group:** click **👥 New group**, name it, add members, create.
- **Verify a contact:** open a chat's **Verify** dialog and compare the
  **safety code** with what your contact sees on their device. Matching codes
  mean the channel is authentic (no man-in-the-middle). This is the one manual
  step that upgrades "encrypted" to "encrypted *and* verified" — see
  [Security & Trust Model](Security-and-Trust-Model).

Next: the full [Features](Features) tour.
