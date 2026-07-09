#!/bin/sh
# Build the Lattix Linux installer (.run) locally.
#
# Usage (from anywhere):  installer/linux/build.sh
#
# Requirements: python3 (3.10+) with venv, and internet access to install
# dependencies. Produces a standalone installer — end users need no Python.
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
[ -e dist/Lattix/Lattix ] || { echo "PyInstaller did not produce dist/Lattix/Lattix" >&2; exit 1; }

sh installer/linux/make_selfextract.sh dist/Lattix
echo "Done."
