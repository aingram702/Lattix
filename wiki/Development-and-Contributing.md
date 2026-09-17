# Development & Contributing

## Repository layout

The application lives at the repository root (see [Architecture](Architecture)
for the full tree). Backend is Python (FastAPI); the frontend is dependency-free
vanilla JS.

## Run locally

```bash
cd Lattix
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py --reload        # http://localhost:8000, auto-reload
```

## Test suites

`scripts/` holds **eleven suites, 282 assertions**: one protocol suite driving the
real server with the real crypto module, and ten browser suites driving the real
UI in headless Chromium (Playwright + axe-core).

| Suite | Covers |
|---|---|
| `integration_test.mjs` | Protocol: registration, login, the key directory, encrypted messaging, plaintext-leak checks, sender self-decryption, tamper rejection, the encrypted-file round-trip, live WebSocket delivery. |
| `ui_test.mjs` | Rendering, grouping, date separators, scroll anchoring, failed-send recovery. |
| `ui_test_media.mjs` | Encrypted image round-trip, inline previews, lightbox, group rendering. |
| `ui_test_a11y.mjs` | axe-core WCAG 2.1 A/AA across every theme, plus a keyboard-only walkthrough. |
| `ui_test_dialogs.mjs` | The dialog controller, and a real encrypted backup/restore round-trip. |
| `ui_test_composer.mjs` | Drag-drop, clipboard paste, drafts, the send-busy lock. |
| `ui_test_sidebar.mjs` | Conversation filter, presence, unread title, reconnect backoff. |
| `ui_test_auth.mjs` | Signup guards, strength meter, vault-overwrite warning. |
| `ui_test_theme.mjs` | System theme, the anti-flash bootstrap, light-mode contrast. |
| `ui_test_perf.mjs` | Render batching, the render window, the expiry sweep. |
| `ui_test_relay.mjs` | Relay settings from sign-in and Settings, a remote relay from a cross-origin page, CORS/cache headers, first-frame WebSocket auth, restart with automatic re-login, missed-message resync, moving an identity. Starts its own relays; `LATTIX_PROXY_BASE` routes it through a reverse proxy. |

```bash
pip install -r requirements.txt
npm i -D playwright axe-core && npx playwright install chromium

# terminal 1 — a server on a test port
LATTIX_DB=/tmp/lattix-test.db python run.py --no-browser --port 8111
# terminal 2 — a suite against it (LATTIX_BASE defaults to :8111)
LATTIX_BASE=http://127.0.0.1:8111 node scripts/integration_test.mjs
LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test.mjs
```

> **Give each suite a fresh relay and database.** `/api/register` is rate-limited
> per IP and the buckets live in the server process, so consecutive runs against
> one relay start returning `429`. Restarting the relay clears them.

`scripts/lib/harness.mjs` holds the shared signup/unlock helpers. `PW_CHROMIUM`
overrides the browser binary if Playwright's download isn't usable.

### Writing UI tests

The browser suites assert **behaviour** — what the DOM does, what axe-core
reports, how many render passes a boot costs — not screenshots, so they stay
meaningful on a loaded CI box.

A handful of things are deliberately *not* driven through the real path, and each
is commented in the suite so nobody "fixes" it later: CDP can't set the OS Caps
Lock state; `setOffline` doesn't close an established WebSocket in Chromium;
`minlength` blocks submit before the JS guard runs; `:focus-visible` styling only
engages for real keyboard focus in headless Chromium; and render batching is
measured at boot replay rather than from a live trickle, since envelopes arriving
seconds apart legitimately render once each.

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
[`installer/README.md`](https://github.com/aingram702/Lattix/blob/main/installer/README.md).

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
  escaping helpers. **No inline `<script>` or inline `style` attributes** — the
  client also ships as an MV3 extension, whose CSP forbids them; use a class or a
  separate file. Batch DOM updates through `scheduleMessages()` /
  `scheduleContacts()` rather than calling the render functions directly.
- **Accessibility:** new interactive elements need a role, an accessible name, and
  keyboard operation; new dialogs go through the shared modal controller so they
  inherit the focus trap, <kbd>Esc</kbd>, and focus return. Never use
  `window.confirm`/`prompt` — use `askModal`. Run `ui_test_a11y.mjs` before
  opening a PR.

## Submitting changes

1. Fork and branch from the default branch.
2. Make the change and run the suites — the protocol suite always, plus the
   browser suites covering what you touched (and `ui_test_a11y.mjs` for anything
   that adds or changes a control).
3. Open a pull request describing what changed and why. For anything
   security-relevant, call it out explicitly.

## Reporting security issues

Report vulnerabilities privately via the repository's security advisory feature —
see [Security & Trust Model](Security-and-Trust-Model).
