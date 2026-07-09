#!/usr/bin/env python3
"""
Lattix desktop launcher (packaged by PyInstaller into Lattix.exe).

At runtime it:
  * points the server at the bundled `client/` assets,
  * keeps the SQLite database in a per-user writable folder
    (%LOCALAPPDATA%\\Lattix on Windows),
  * starts the FastAPI relay on 127.0.0.1, and
  * opens the app in the default browser.

The plain `run.py` remains the way to launch from a source checkout; this
module only exists so a frozen, dependency-free .exe can boot the same server.
"""

import os
import sys
import time
import threading
import webbrowser


def _resource_base() -> str:
    """Directory that holds bundled resources (client/, server/)."""
    if getattr(sys, "frozen", False):
        # PyInstaller unpacks datas next to the executable's temp dir.
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _data_dir() -> str:
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") \
            or os.path.expanduser("~")
        path = os.path.join(base, "Lattix")
    else:
        base = os.environ.get("XDG_DATA_HOME") \
            or os.path.join(os.path.expanduser("~"), ".local", "share")
        path = os.path.join(base, "lattix")
    os.makedirs(path, exist_ok=True)
    return path


def _redirect_logs(data_dir: str) -> None:
    """A windowed (no-console) build has no stdout/stderr; give uvicorn a real
    file to write to so its logging config doesn't crash on None."""
    if sys.stdout and sys.stderr:
        return
    log = open(os.path.join(data_dir, "lattix.log"), "a", buffering=1, encoding="utf-8")
    sys.stdout = log
    sys.stderr = log


def _fatal(message: str) -> None:
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, str(message), "Lattix — error", 0x10)
    except Exception:
        print("Lattix failed to start:", message)


def main() -> None:
    base = _resource_base()
    data = _data_dir()
    _redirect_logs(data)

    os.environ.setdefault("LATTIX_CLIENT_DIR", os.path.join(base, "client"))
    os.environ.setdefault("LATTIX_DB", os.path.join(data, "lattix.db"))
    if base not in sys.path:
        sys.path.insert(0, base)

    host = os.environ.get("LATTIX_HOST", "127.0.0.1")
    port = int(os.environ.get("LATTIX_PORT", "8000"))
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}"

    def open_browser() -> None:
        time.sleep(1.5)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=open_browser, daemon=True).start()

    try:
        import uvicorn
        from server.main import app
        uvicorn.run(app, host=host, port=port, log_level="info")
    except Exception as exc:  # pragma: no cover - surfaced to the user via dialog
        _fatal(f"{exc}\n\nSee {os.path.join(data, 'lattix.log')} for details.")
        raise


if __name__ == "__main__":
    main()
