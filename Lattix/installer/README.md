# Lattix installers

Standalone installers that bundle a Python runtime, the FastAPI relay, and the
full web client via [PyInstaller](https://pyinstaller.org/). **End users do not
need Python installed.** Launching Lattix starts the local relay on
`http://localhost:8000` and opens it in the browser.

| Platform | Output | Wrapper |
|----------|--------|---------|
| Windows  | `LattixSetup.exe` | [Inno Setup](https://jrsoftware.org/isinfo.php) |
| macOS    | `Lattix-<ver>-<arch>.dmg` (drag-to-install `.app`) | `hdiutil` |
| Linux    | `Lattix-<ver>-<arch>.run` (self-extracting) | built-in |

Data is stored per-user: `%LOCALAPPDATA%\Lattix` on Windows,
`~/Library/Application Support/Lattix` on macOS,
`~/.local/share/lattix` on Linux.

> Each installer is a native binary and **must be built on its own OS** —
> PyInstaller doesn't cross-compile. The bundled GitHub Actions workflows build
> both automatically (no local toolchain needed).

---

## Linux — self-extracting `.run`

A single executable installer. Running it unpacks the bundled app and installs
it with an app-menu entry and a `lattix` launcher — per-user by default, or
system-wide (`/opt/lattix`) when run as root.

**Build via CI (recommended):** the
[`build-linux-installer`](../../.github/workflows/build-linux-installer.yml)
workflow builds it on `ubuntu-latest`. Download the `.run` from the run's
Artifacts, or push a `v*` tag to attach it to a release.

**Build locally on Linux** (needs `python3` + venv):

```bash
installer/linux/build.sh            # -> installer/linux/Output/Lattix-<ver>-<arch>.run
```

**Install / uninstall:**

```bash
chmod +x Lattix-1.1.0-x86_64.run
./Lattix-1.1.0-x86_64.run           # per-user (or system-wide if run as root)
./Lattix-1.1.0-x86_64.run --user    # force per-user even as root
./Lattix-1.1.0-x86_64.run --uninstall
```

---

## macOS — `.dmg`

A standard drag-to-install disk image containing `Lattix.app` next to an
`/Applications` shortcut.

**Build via CI (recommended):** the
[`build-macos-installer`](../../.github/workflows/build-macos-installer.yml)
workflow builds it on `macos-latest`. Download the `.dmg` from the run's
Artifacts, or push a `v*` tag to attach it to a release.

**Build locally on macOS** (needs `python3`):

```bash
installer/macos/build.sh            # -> installer/macos/Output/Lattix-<ver>-<arch>.dmg
```

Then open the `.dmg` and drag **Lattix** to **Applications**. The app is not
code-signed, so the first launch needs a right-click → **Open** (or
*System Settings → Privacy & Security → Open Anyway*).

---

## Windows — `LattixSetup.exe`

Bundles the app and wraps it with Inno Setup into a double-click installer with
Start Menu / Desktop shortcuts.

### Build via CI (recommended)

No Windows machine required. The workflow
[`build-windows-installer`](../../.github/workflows/build-windows-installer.yml)
builds the installer on a `windows-latest` runner.

- **On demand:** GitHub → *Actions* → *Build Windows installer* → *Run
  workflow*. Download `LattixSetup.exe` from the run's *Artifacts*.
- **On release:** push a tag like `v1.1.0`; the installer is built and attached
  to the GitHub Release automatically.

### Build locally on Windows

Requirements:

- Python 3.10+ on `PATH`
- [Inno Setup 6+](https://jrsoftware.org/isdl.php) (`ISCC.exe`)

From the project root (the folder containing `server/` and `client/`):

```powershell
installer\build.bat
```

or directly:

```powershell
./installer/build.ps1
```

Output: `installer\Output\LattixSetup.exe`.

## What's here

| File | Purpose |
|------|---------|
| `lattix_launcher.py` | Frozen entry point (both OSes) — configures paths, starts the relay, opens the browser. |
| `lattix.spec` | PyInstaller build (bundles `server/` code + `client/` assets); icon/version are applied on Windows only. |
| `requirements-build.txt` | Build-time deps (PyInstaller). |
| `version_info.txt`, `lattix.ico` | Windows version resource + multi-resolution icon. |
| `lattix.icns` | macOS app-bundle icon. |
| `lattix.iss`, `build.ps1`, `build.bat` | Windows: Inno Setup script → `LattixSetup.exe`, plus local build scripts. |
| `macos/make_dmg.sh`, `macos/build.sh` | macOS: package `Lattix.app` into a `.dmg`, plus one-command build. |
| `linux/install.sh` | Linux: post-extraction installer (app-menu entry, `lattix` launcher, uninstall). |
| `linux/lattix.desktop` | Linux: desktop-entry template. |
| `linux/make_selfextract.sh` | Linux: wraps the PyInstaller bundle into a `.run` self-extractor. |
| `linux/build.sh` | Linux: one-command local build. |

## Notes

- The relay binds to `127.0.0.1` only, so no inbound firewall rule is needed.
  Set `LATTIX_HOST` / `LATTIX_PORT` env vars to change that.
- To connect the **Chrome extension** to this local install, set its server URL
  to `http://localhost:8000` in Settings.
