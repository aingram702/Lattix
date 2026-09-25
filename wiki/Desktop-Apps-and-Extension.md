# Desktop Apps & Extension

Beyond the web app, Lattix ships as native desktop installers and a Chrome
extension. All of them run the same client code and the same local crypto.

## Chrome extension

The `client/` directory doubles as an unpacked Chrome **MV3** extension — one
codebase, the same files the relay serves.

1. Run a Lattix relay (from source, an installer, or a deployment).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select the `client/` folder.
3. Click the Lattix toolbar icon (it opens the app in a tab).
4. On the sign-in screen click **Change** next to *Relay: …* and set your server
   URL (default `http://localhost:8000`; use your `https://…` domain for a hosted
   relay). **Test connection** checks it before you save. Once signed in, the same
   dialog is under **Settings → Relay server → Change…**.

The extension is a thin shell: all crypto runs locally and it talks only to the
relay you configure.

## Standalone desktop installers

Each installer bundles a Python runtime, the FastAPI relay, and the web client
via **PyInstaller** — **end users need no Python**. Launching Lattix starts a
local relay on `http://localhost:8000` and opens it in the browser. The database
is stored per-user (see [Configuration](Configuration)).

### Using a hosted relay from the desktop app

The built-in relay only reaches people on the same machine. To chat over the
internet, point the desktop app at a shared relay — for example one on your own
VPS ([Self-Hosting & Deployment](Self-Hosting-and-Deployment)):

1. Sign-in screen → **Relay: this server · Change** (or **Settings → Relay server
   → Change…**).
2. Enter `https://chat.example.com` → **Test connection** → **Save & connect**.
3. Create an account, or unlock your vault. If the relay doesn't know your
   identity yet, Lattix offers to **register it there** with the same keys and
   safety code.

The app keeps running its local relay in the background, but all traffic goes to
the relay you chose. The status strip shows which one you're connected to, and
share links / QR codes point at it, so contacts can open them. Relays ≥ 2.1 allow
desktop-app and extension origins by default; for an older relay set
`LATTIX_CORS_ORIGINS=http://localhost:8000`.

| Platform | Artifact | Wrapper |
|----------|----------|---------|
| Windows  | `LattixSetup.exe` | Inno Setup (Start Menu / Desktop shortcuts) |
| macOS    | `Lattix-<ver>-<arch>.dmg` | drag-to-install `.app` |
| Linux    | `Lattix-<ver>-<arch>.run` | self-extracting installer + app-menu entry |

### Getting the installers

- **From CI (no local toolchain):** GitHub → **Actions** → the matching
  *Build … installer* workflow → **Run workflow**, then download the artifact.
  Pushing a `v*` tag attaches all installers to a **Release**.
- **Build locally** on the matching OS:
  - Windows: `installer\build.bat` (needs [Inno Setup 6](https://jrsoftware.org/isdl.php))
  - macOS: `installer/macos/build.sh`
  - Linux: `installer/linux/build.sh`

> Each installer is a native binary and **must be built on its own OS** —
> PyInstaller doesn't cross-compile.

### Linux `.run` install / uninstall

```bash
chmod +x Lattix-2.2.0-x86_64.run
./Lattix-2.2.0-x86_64.run           # per-user, or system-wide if run as root
./Lattix-2.2.0-x86_64.run --user    # force per-user even as root
./Lattix-2.2.0-x86_64.run --uninstall
```

### macOS note

The app is not code-signed, so the first launch needs a right-click → **Open**
(or *System Settings → Privacy & Security → Open Anyway*).

For the full breakdown of the packaging scripts, see
[`installer/README.md`](https://github.com/aingram702/Lattix/blob/main/installer/README.md).

## Which should I use?

- **Just trying it / one device:** a desktop installer — one download, no setup.
- **Chatting with others over the internet:** host a relay
  ([Self-Hosting & Deployment](Self-Hosting-and-Deployment)) and point the
  desktop apps or the extension at it, or just open its web app.
