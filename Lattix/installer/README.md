# Lattix Windows installer

This folder builds **`LattixSetup.exe`** — a standalone, double-click installer
for Windows. It bundles a Python runtime, the FastAPI relay, and the full web
client via [PyInstaller](https://pyinstaller.org/), then wraps that into an
installer with [Inno Setup](https://jrsoftware.org/isinfo.php). **End users do
not need Python installed.**

After installing, launching **Lattix** starts the local relay on
`http://localhost:8000` and opens it in the browser. The SQLite database lives
in `%LOCALAPPDATA%\Lattix`.

> The installer is a Windows binary and **must be built on Windows** —
> PyInstaller and Inno Setup are native Windows tools and cannot cross-compile
> from Linux/macOS. Use one of the two paths below.

## Option A — build automatically with GitHub Actions (recommended)

No Windows machine required. The workflow
[`.github/workflows/build-windows-installer.yml`](../../.github/workflows/build-windows-installer.yml)
builds the installer on a `windows-latest` runner.

- **On demand:** GitHub → *Actions* → *Build Windows installer* → *Run
  workflow*. Download `LattixSetup.exe` from the run's *Artifacts*.
- **On release:** push a tag like `v1.1.0`; the installer is built and attached
  to the GitHub Release automatically.

## Option B — build locally on Windows

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
| `lattix_launcher.py` | Frozen entry point — configures paths, starts the relay, opens the browser. |
| `lattix.spec` | PyInstaller build (bundles `server/` code + `client/` assets). |
| `version_info.txt` | Windows version resource embedded in `Lattix.exe`. |
| `lattix.ico` | Multi-resolution app/installer icon. |
| `lattix.iss` | Inno Setup script → `LattixSetup.exe`. |
| `build.ps1` / `build.bat` | One-command local build. |
| `requirements-build.txt` | Build-time deps (PyInstaller). |

## Notes

- The relay binds to `127.0.0.1` only, so no inbound firewall rule is needed.
  Set `LATTIX_HOST` / `LATTIX_PORT` env vars to change that.
- To connect the **Chrome extension** to this local install, set its server URL
  to `http://localhost:8000` in Settings.
