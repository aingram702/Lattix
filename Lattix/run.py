#!/usr/bin/env python3
"""
Lattix launcher.

Usage:
    python run.py                 # start on http://127.0.0.1:8000
    python run.py --host 0.0.0.0 --port 9000
    python run.py --reload        # dev auto-reload
"""

import argparse
import webbrowser
import threading
import time

import uvicorn


def _open_browser(url: str) -> None:
    time.sleep(1.2)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Lattix server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    print(f"\n  Lattix — quantum-resistant messaging")
    print(f"  → {url}\n")

    if not args.no_browser and not args.reload:
        threading.Thread(target=_open_browser, args=(url,), daemon=True).start()

    uvicorn.run(
        "server.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
