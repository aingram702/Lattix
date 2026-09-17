#!/usr/bin/env python3
"""
Lattix launcher.

Usage:
    python run.py                 # start on http://127.0.0.1:8000
    python run.py --host 0.0.0.0 --port 9000
    python run.py --reload        # dev auto-reload

Behind a reverse proxy (Caddy/nginx on the same VPS):
    python run.py --no-browser --host 127.0.0.1 --port 8000 \
        --forwarded-allow-ips 127.0.0.1

    The relay then takes the client address from X-Forwarded-For (so per-IP
    rate limiting sees real users, not the proxy) — but only for connections
    arriving from the listed proxy addresses, so it can't be spoofed directly.
"""

import argparse
import os
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
    parser.add_argument("--host", default=os.environ.get("LATTIX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument(
        "--forwarded-allow-ips",
        default=os.environ.get("LATTIX_FORWARDED_ALLOW_IPS", "127.0.0.1"),
        help="comma-separated proxy IPs whose X-Forwarded-* headers are trusted "
             "(default 127.0.0.1; '*' only when the relay is unreachable except via the proxy)",
    )
    parser.add_argument(
        "--keep-alive", type=int,
        default=int(os.environ.get("LATTIX_KEEPALIVE", "75")),
        help="idle HTTP keep-alive seconds (default 75). Must exceed the reverse "
             "proxy's upstream keep-alive, or pooled connections get closed "
             "under it and surface as sporadic 502s.",
    )
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
        proxy_headers=True,
        forwarded_allow_ips=args.forwarded_allow_ips,
        timeout_keep_alive=args.keep_alive,
    )


if __name__ == "__main__":
    main()
