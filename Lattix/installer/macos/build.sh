#!/bin/sh
# Build the Lattix macOS disk image (.dmg) locally. macOS only.
#
# Usage (from anywhere):  installer/macos/build.sh
#
# Requirements: python3 (3.10+). Produces a standalone Lattix.app inside a .dmg
# — end users need no Python.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
echo "Building Lattix from $ROOT"

python3 -m venv .venv-build
# shellcheck disable=SC1091
. .venv-build/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -r installer/requirements-build.txt

rm -rf build dist
pyinstaller --noconfirm installer/lattix.spec
[ -d dist/Lattix.app ] || { echo "PyInstaller did not produce dist/Lattix.app" >&2; exit 1; }

sh installer/macos/make_dmg.sh dist/Lattix.app
echo "Done."
