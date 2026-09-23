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

A note on plain http:// — it is not a Lattix policy, it is the browser's:
`crypto.subtle` exists only in a "secure context", which means HTTPS, or
http:// on localhost / 127.0.0.1 / [::1]. A relay reached over http:// at a LAN
or public address serves a page whose cryptography is switched off, so the app
cannot work there however it is configured. Bind to loopback and put a
certificate in front (see DEPLOYMENT.md and deploy/vps/), or reach it through
an SSH tunnel to localhost.
"""

import argparse
import os
import shutil
import socket
import sys
import threading
import time
import webbrowser

import uvicorn

# Addresses the browser treats as a secure context over plain http.
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _open_browser(url: str) -> None:
    time.sleep(1.2)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _can_open_browser() -> bool:
    """True when opening a browser has a chance of doing something.

    On a headless server webbrowser.open() either finds nothing and returns
    False, or launches a text-mode browser nobody asked for. Both used to look
    like "it started but no page came up", so check before spawning the thread.
    """
    if sys.platform in ("darwin", "win32"):
        return True
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return True
    # A desktop session may still be reachable through an explicit BROWSER.
    return bool(os.environ.get("BROWSER") and shutil.which(os.environ["BROWSER"].split()[0]))


def _primary_address() -> str:
    """This machine's outward-facing IP, for the 'reachable at' hint.

    Opening a UDP socket to a public address performs no traffic but makes the
    kernel pick the interface it would route through, which is the address a
    remote client would use. Falls back to the hostname's resolution.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("198.51.100.1", 53))  # TEST-NET-2, never routed
        return probe.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "<this machine's address>"
    finally:
        probe.close()


def _banner(host: str, port: int) -> str:
    """What to actually type into a browser, and the truth about whether it
    will work from somewhere else."""
    bound_everywhere = host in ("0.0.0.0", "::", "")
    local_url = f"http://localhost:{port}"
    lines = ["", "  Lattix — quantum-resistant messaging", ""]

    if bound_everywhere or host not in LOOPBACK:
        addr = _primary_address() if bound_everywhere else host
        lines += [
            f"  On this machine:  {local_url}",
            f"  From elsewhere:   http://{addr}:{port}",
            "",
            "  ⚠  http:// works only on localhost. Browsers switch off the Web Crypto",
            "     API on any other address without HTTPS, and Lattix cannot create or",
            "     unlock a vault without it — the sign-in page will load and then fail.",
            "",
            "     Put a certificate in front of the relay (deploy/vps/install-debian.sh",
            "     does Caddy + Let's Encrypt in one command; see DEPLOYMENT.md), or, to",
            "     test right now, tunnel from your own machine and use localhost:",
            "",
            f"       ssh -N -L {port}:127.0.0.1:{port} user@{_primary_address() if bound_everywhere else host}",
        ]
    else:
        lines.append(f"  → {local_url}")
        if not _can_open_browser():
            lines += [
                "",
                "  No browser on this machine, and the relay is bound to loopback, so",
                "  nothing outside it can connect. To reach it from your own computer:",
                "",
                f"    ssh -N -L {port}:127.0.0.1:{port} user@{_primary_address()}",
                "",
                f"  then open {local_url} there. To serve it publicly instead, see",
                "  DEPLOYMENT.md — it needs HTTPS, not just a wider bind address.",
            ]
    lines.append("")
    return "\n".join(lines)


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

    print(_banner(args.host, args.port), flush=True)

    # Only chase a browser when there is one to chase: on a headless VPS this
    # thread silently did nothing, which read as "the app never opened".
    if not args.no_browser and not args.reload and _can_open_browser():
        threading.Thread(
            target=_open_browser, args=(f"http://localhost:{args.port}",), daemon=True
        ).start()

    try:
        uvicorn.run(
            "server.main:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            proxy_headers=True,
            forwarded_allow_ips=args.forwarded_allow_ips,
            timeout_keep_alive=args.keep_alive,
        )
    except OSError as exc:
        # Address already in use is the other common "it starts but nothing
        # comes up" — uvicorn's own traceback buries the cause.
        if getattr(exc, "errno", None) in (98, 48, 10048):
            sys.exit(
                f"\n  Port {args.port} is already in use on {args.host}.\n"
                f"  Another Lattix may still be running: try `python run.py --port {args.port + 1}`,\n"
                f"  or stop the existing one (ss -ltnp | grep {args.port}).\n"
            )
        raise


if __name__ == "__main__":
    main()
