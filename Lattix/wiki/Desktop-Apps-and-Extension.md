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
4. Open **Settings → Relay server** and set your server URL
   (default `http://localhost:8000`; use your `https://…` domain for a hosted
   relay).

The extension is a thin shell: all crypto runs locally and it talks only to the
relay you configure.

## Standalone desktop installers

Each installer bundles a Python runtime, the FastAPI relay, and the web client
via **PyInstaller** — **end users need no Python**. Launching Lattix starts a
local relay on `http://localhost:8000` and opens it in the browser. The database
is stored per-user (see [Configuration](Configuration)).

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
chmod +x Lattix-1.1.0-x86_64.run
./Lattix-1.1.0-x86_64.run           # per-user, or system-wide if run as root
./Lattix-1.1.0-x86_64.run --user    # force per-user even as root
./Lattix-1.1.0-x86_64.run --uninstall
```

### macOS note

The app is not code-signed, so the first launch needs a right-click → **Open**
(or *System Settings → Privacy & Security → Open Anyway*).

For the full breakdown of the packaging scripts, see
[`installer/README.md`](https://github.com/aingram702/Lattix/blob/main/Lattix/installer/README.md).

## Which should I use?

- **Just trying it / one device:** a desktop installer — one download, no setup.
- **Chatting with others over the internet:** host a relay
  ([Self-Hosting & Deployment](Self-Hosting-and-Deployment)) and point the web app
  or the extension at it.
