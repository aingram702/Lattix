# Development & Contributing

## Repository layout

The app lives in the repo's `Lattix/` subfolder (see [Architecture](Architecture)
for the full tree). Backend is Python (FastAPI); the frontend is dependency-free
vanilla JS.

## Run locally

```bash
cd Lattix/Lattix
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py --reload        # http://localhost:8000, auto-reload
```

## End-to-end test suite

`scripts/integration_test.mjs` exercises the real server with the real client
crypto module: registration, login, the key directory, encrypted messaging,
plaintext-leak checks, sender self-decryption, tamper rejection, the
encrypted-file round-trip, and live WebSocket delivery.

```bash
# terminal 1 — start a server on a test port
python run.py --no-browser --port 8111
# terminal 2 — run the suite against it (needs Node.js)
node scripts/integration_test.mjs        # uses LATTIX_BASE, defaults to :8111
```

## Rebuilding the vendored crypto bundle

The post-quantum library is vendored as a single offline file
(`client/vendor/lattix-pqc.js`). Rebuild it (needs Node.js) with:

```bash
bash scripts/build_vendor.sh
```

## Building the installers

Per-OS installer builds live under `installer/` (Windows/macOS/Linux) with a
one-command build script each and matching GitHub Actions workflows. See
[Desktop Apps & Extension](Desktop-Apps-and-Extension) and
[`installer/README.md`](https://github.com/aingram702/Lattix/blob/main/Lattix/installer/README.md).

## Continuous integration

The repo includes GitHub Actions workflows that build the three desktop
installers on their native runners and a `docker-image` workflow that builds and
publishes the container image to GHCR. Use them to produce artifacts without a
local toolchain.

## Coding conventions

- **Backend:** keep the relay a *zero-knowledge* store — never inspect or depend
  on the structure of message/file payloads; treat them as opaque. New endpoints
  should authenticate with the `require_user` dependency and validate input with
  Pydantic models.
- **Crypto:** changes to `client/js/crypto.js` must keep 1:1 envelopes
  byte-compatible (the integration test and existing histories depend on it).
  New signed data must be covered by the signature transcript.
- **Frontend:** no external runtime dependencies or CDNs — the app must keep
  working fully offline. Render user-controlled text through the existing
  escaping helpers.

## Submitting changes

1. Fork and branch from the default branch.
2. Make the change and run the integration suite (and, for UI changes, click
   through the affected flows).
3. Open a pull request describing what changed and why. For anything
   security-relevant, call it out explicitly.

## Reporting security issues

Report vulnerabilities privately via the repository's security advisory feature —
see [Security & Trust Model](Security-and-Trust-Model).
