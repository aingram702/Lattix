#!/bin/sh
# Lattix installer — runs after the self-extracting archive unpacks.
#
# Installs the bundled (PyInstaller) app with an app-menu entry and a `lattix`
# launcher. Runs per-user by default, or system-wide when invoked as root.
set -eu

APP_NAME=Lattix
HERE=$(cd "$(dirname "$0")" && pwd)

usage() {
  cat <<EOF
$APP_NAME installer

Usage: ./Lattix-<ver>-<arch>.run [-- OPTIONS]
  --user         force a per-user install under \$HOME (even when run as root)
  --prefix DIR   install app files under DIR (default: chosen automatically)
  --uninstall    remove a previous installation
  --help         show this help

Run as root for a system-wide install (/opt/lattix); otherwise it installs
under your home directory (~/.local).
EOF
}

MODE=install
PREFIX_OVERRIDE=
FORCE_USER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --user) FORCE_USER=1 ;;
    --prefix) PREFIX_OVERRIDE=${2:?--prefix needs a directory}; shift ;;
    --prefix=*) PREFIX_OVERRIDE=${1#*=} ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ "$(id -u)" = "0" ] && [ "$FORCE_USER" = "0" ]; then
  APPDIR=${PREFIX_OVERRIDE:-/opt/lattix}
  BINDIR=/usr/local/bin
  DESKTOPDIR=/usr/share/applications
  ICONDIR=/usr/share/icons/hicolor/128x128/apps
else
  APPDIR=${PREFIX_OVERRIDE:-$HOME/.local/opt/lattix}
  BINDIR=$HOME/.local/bin
  DESKTOPDIR=$HOME/.local/share/applications
  ICONDIR=$HOME/.local/share/icons/hicolor/128x128/apps
fi
LAUNCHER=$BINDIR/lattix
DESKTOP_FILE=$DESKTOPDIR/lattix.desktop
ICON_FILE=$ICONDIR/lattix.png

refresh_caches() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOPDIR" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -f -t "$(dirname "$(dirname "$(dirname "$ICONDIR")")")" 2>/dev/null || true
}

if [ "$MODE" = uninstall ]; then
  echo "Removing $APP_NAME…"
  rm -rf "$APPDIR"
  rm -f "$LAUNCHER" "$DESKTOP_FILE" "$ICON_FILE"
  refresh_caches
  echo "$APP_NAME removed."
  exit 0
fi

echo "Installing $APP_NAME to $APPDIR…"
rm -rf "$APPDIR"
mkdir -p "$APPDIR" "$BINDIR" "$DESKTOPDIR" "$ICONDIR"
cp -a "$HERE/app/." "$APPDIR/"
chmod +x "$APPDIR/Lattix" 2>/dev/null || true

ln -sf "$APPDIR/Lattix" "$LAUNCHER"
cp -f "$HERE/lattix.png" "$ICON_FILE"
sed -e "s|@EXEC@|$APPDIR/Lattix|g" -e "s|@ICON@|$ICON_FILE|g" \
    "$HERE/lattix.desktop" > "$DESKTOP_FILE"
chmod 644 "$DESKTOP_FILE"
refresh_caches

echo ""
echo "$APP_NAME installed."
echo "  • Launch it from your application menu, or run: $LAUNCHER"
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *) echo "  • Note: $BINDIR is not on your PATH — add it, or use the full path above." ;;
esac
echo "  • It starts a local server on http://localhost:8000 and opens your browser."
echo "  • To uninstall, re-run this installer with --uninstall"
