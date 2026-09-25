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

`scripts/` holds **15 suites**: a Python suite for the database layer, three
Node suites that drive a real relay with the real crypto module, and eleven
browser suites that drive the real UI in headless Chromium (Playwright + axe-core).

| Suite | Covers |
|---|---|
| `db_test.py` | Migration from 1.x databases, owner succession on account deletion, expired-blob cleanup, history page size. Needs no relay. |
| `integration_test.mjs` | Protocol: registration, login, directory, encrypted messaging, plaintext-leak checks, self-decryption, tamper rejection, file round-trip, live delivery. |
| `server_test.mjs` | Relay rules: input validation, file access control (incl. the 2.1.1 IDOR), group succession on leave, presence across sessions, session invalidation. |
| `regression_test.mjs` | The 2.2 review findings: fingerprint/key consistency, registration races, account deletion (groups, sockets, presence), binary WebSocket frames, history paging, docs/schema exposure, file format v2 (encrypted names, substitution/replay/downgrade resistance, v1 compatibility), vault work factor. |
| `ui_test.mjs` | Rendering, grouping, date separators, scroll anchoring, failed-send recovery. |
| `ui_test_auth.mjs` | Signup guards, strength meter, vault-overwrite warning. |
| `ui_test_sidebar.mjs` | Conversation filter, presence, unread title, reconnect backoff. |
| `ui_test_composer.mjs` | Drag-drop, clipboard paste, drafts, the send-busy lock. |
| `ui_test_dialogs.mjs` | The dialog controller, and a real encrypted backup/restore round-trip. |
| `ui_test_media.mjs` | Encrypted image round-trip, inline previews, lightbox, group rendering. |
| `ui_test_theme.mjs` | System theme, the anti-flash bootstrap, light-mode contrast. |
| `ui_test_a11y.mjs` | axe-core WCAG 2.1 A/AA across every theme, plus a keyboard-only walkthrough. |
| `ui_test_perf.mjs` | Render batching, the render window, the expiry sweep. |
| `ui_test_relay.mjs` | Relay settings, cross-origin relays, CORS/cache headers, first-frame WebSocket auth, restart with re-login, resync, moving an identity. Starts its own relays; `LATTIX_PROXY_BASE` routes it through a reverse proxy. |
| `ui_test_trust.mjs` | Share-link verification (match and mismatch), the key-change banner and send gating, a 500+ message history, encrypted file names, vault re-sealing on unlock. |

The simplest way to run everything is the runner, which starts a relay on a
scratch database (with auth rate limiting off) and runs every suite in order:

```bash
pip install -r requirements.txt
npm install && npx playwright install chromium
node scripts/run_all_tests.mjs          # or: npm run test:all
```

To run suites by hand:

```bash
# terminal 1 — a relay on a test port, rate limiting off
LATTIX_DB=/tmp/lattix-test.db LATTIX_RATE_LIMIT_MAX=0 python run.py --no-browser --port 8111
# terminal 2 — suites against it (LATTIX_BASE defaults to :8111)
LATTIX_BASE=http://127.0.0.1:8111 node scripts/regression_test.mjs
LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_trust.mjs
python3 scripts/db_test.py              # no relay needed
```

> **Turn rate limiting off for test relays.** `/api/register` and `/api/login`
> are limited per IP (10 per 5 minutes by default) and the suites create dozens
> of accounts from one address. Never set `LATTIX_RATE_LIMIT_MAX=0` on a public
> relay.

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

GitHub Actions workflows under `.github/workflows/`:

| Workflow | Runs on | Does |
|---|---|---|
| `tests.yml` | push to `main`, pull requests | Installs Python 3.12, Node 22 and Chromium, runs all 15 suites. |
| `docker-image.yml` | push to `main`, `v*` tags | Builds the `Dockerfile` at the repo root and publishes `ghcr.io/<owner>/lattix`. |
| `build-{windows,macos,linux}-installer.yml` | `v*` tags, manual | Builds each installer on its native runner; tags attach them to the Release. Untagged builds take their version from `server/__init__.py`. |

All workflows build from the repository root (before 2.2 they pointed at a
`Lattix/` subdirectory and failed).

## Releasing

`server/__init__.py`'s `__version__` is the source of truth (reported by
`/api/health`). Bump it together with `package.json`, `client/manifest.json`,
`installer/lattix.iss`, `installer/lattix.spec` and `installer/version_info.txt`,
add a section to [Release Notes](Release-Notes), then push a `vX.Y.Z` tag.

## Coding conventions

- **Backend:** keep the relay a *zero-knowledge* store — never inspect or depend
  on the structure of message/file payloads; treat them as opaque. New endpoints
  should authenticate with the `require_user` dependency and validate input with
  Pydantic models.
- **Crypto:** changes to `client/js/crypto.js` must keep existing histories
  readable — 1:1 message envelopes are byte-compatible with 1.x, and v1 file
  payloads must keep opening. Anything a recipient relies on must be covered by
  the signature transcript, and a new format needs a new domain prefix so it
  can't be downgraded. Add a compatibility check to `regression_test.mjs`.
- **Trust:** never display, pin or compare a fingerprint the relay supplied —
  compute it with `fingerprintOf()`. Key records from the relay go through
  `adoptPeerKeys()` in `app.js`.
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
