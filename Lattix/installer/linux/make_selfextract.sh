#!/bin/sh
# Build a self-extracting Lattix installer (.run) from a PyInstaller onedir
# bundle. Dependency-free: a shell header is prepended to a gzipped tar payload.
#
# Usage (from anywhere):  installer/linux/make_selfextract.sh [APP_DIR]
#   APP_DIR  the PyInstaller output dir (default: dist/Lattix)
#
# Output: installer/linux/Output/Lattix-<version>-<arch>.run
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)   # project root (…/Lattix)
cd "$ROOT"

APP_DIR=${1:-dist/Lattix}
VERSION=${LATTIX_VERSION:-1.1.0}
ARCH=$(uname -m)
OUTDIR=installer/linux/Output
OUT="$OUTDIR/Lattix-$VERSION-$ARCH.run"

[ -d "$APP_DIR" ] || { echo "App dir not found: $APP_DIR" >&2; exit 1; }
[ -e "$APP_DIR/Lattix" ] || echo "warning: $APP_DIR/Lattix missing (stub build?)" >&2

STAGE=$(mktemp -d)
PAYLOAD=$(mktemp)
trap 'rm -rf "$STAGE" "$PAYLOAD"' EXIT INT TERM

mkdir -p "$STAGE/app"
cp -a "$APP_DIR/." "$STAGE/app/"
cp installer/linux/install.sh "$STAGE/install.sh"
cp installer/linux/lattix.desktop "$STAGE/lattix.desktop"
cp client/icons/icon128.png "$STAGE/lattix.png"
chmod +x "$STAGE/install.sh"

tar czf "$PAYLOAD" -C "$STAGE" .

mkdir -p "$OUTDIR"
cat > "$OUT" <<'HEADER'
#!/bin/sh
# Self-extracting Lattix installer. Unpacks a bundled app and runs install.sh.
set -eu
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT INT TERM
ARCHIVE_LINE=$(awk '/^__LATTIX_PAYLOAD_BELOW__$/ { print NR + 1; exit 0; }' "$0")
tail -n +"$ARCHIVE_LINE" "$0" | tar xz -C "$TMPDIR"
( cd "$TMPDIR" && sh ./install.sh "$@" )
exit $?
__LATTIX_PAYLOAD_BELOW__
HEADER
cat "$PAYLOAD" >> "$OUT"
chmod +x "$OUT"

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
