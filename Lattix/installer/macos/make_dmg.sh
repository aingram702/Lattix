#!/bin/sh
# Package the PyInstaller Lattix.app bundle into a distributable .dmg.
# macOS only (uses hdiutil).
#
# Usage (from anywhere):  installer/macos/make_dmg.sh [APP_BUNDLE]
#   APP_BUNDLE  path to the .app (default: dist/Lattix.app)
#
# Output: installer/macos/Output/Lattix-<version>-<arch>.dmg
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)   # project root (…/Lattix)
cd "$ROOT"

APP=${1:-dist/Lattix.app}
VERSION=${LATTIX_VERSION:-1.1.0}
ARCH=$(uname -m)
OUTDIR=installer/macos/Output
OUT="$OUTDIR/Lattix-$VERSION-$ARCH.dmg"

[ -d "$APP" ] || { echo "App bundle not found: $APP" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

# Drag-to-install layout: the .app next to an Applications symlink.
cp -R "$APP" "$STAGE/Lattix.app"
ln -s /Applications "$STAGE/Applications"

mkdir -p "$OUTDIR"
rm -f "$OUT"
hdiutil create \
  -volname "Lattix" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$OUT"

echo "Built $OUT"
