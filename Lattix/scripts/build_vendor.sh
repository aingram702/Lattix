#!/usr/bin/env bash
# Rebuild client/vendor/lattix-pqc.js from @noble/post-quantum.
# Requires Node.js + npm. Run from the repo root: bash scripts/build_vendor.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$HERE/.build"
mkdir -p "$WORK"
cd "$WORK"

cat > package.json <<'JSON'
{ "name": "lattix-vendor-build", "version": "1.0.0", "type": "module", "private": true }
JSON

npm install @noble/post-quantum@0.4.1 esbuild@0.24.0

cat > entry.js <<'JS'
export { ml_kem768 } from '@noble/post-quantum/ml-kem';
export { ml_dsa65 } from '@noble/post-quantum/ml-dsa';
export { randomBytes } from '@noble/post-quantum/utils';
JS

./node_modules/.bin/esbuild entry.js --bundle --format=esm --minify \
  --outfile="$ROOT/client/vendor/lattix-pqc.js"

echo "Rebuilt $ROOT/client/vendor/lattix-pqc.js"
