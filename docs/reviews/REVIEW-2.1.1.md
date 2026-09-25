# Lattix 2.1.1 — code review & VPS debug

Reviewed: the 2.1.1 changed-files bundle merged onto the current `main` of
github.com/aingram702/Lattix (the bundle alone is a partial tree — no `client/`
HTML/CSS, no `requirements.txt`, no `deploy/vps/lattix.service` or Caddyfile).

## What was verified

| Check | Result |
|---|---|
| Full test suite (`scripts/run_all_tests.mjs`, 12 suites, ~310 checks: protocol, WebSocket, UI, a11y, relay switching) | **all pass**, before and after the fixes |
| Relay started exactly as `lattix.service` starts it (uvicorn flags, env file) | starts, `/api/health` OK |
| `Caddyfile.template` rendered and checked with Caddy 2.10.2 | valid |
| Browser (Chromium) → **HTTPS through Caddy** → relay: create account, open `wss://…/ws` | works, no page errors |
| Browser → **plain `http://<public-ip>:8000`** | page loads, shows "This page can't run Lattix's cryptography" (by design) |
| `install-debian.sh`, installer shell scripts | `bash -n` and ShellCheck clean |

**Conclusion: the application code isn't what keeps the site from opening.** The same code
works end to end behind HTTPS. When it fails on an OVH VPS, the cause is almost
always one of these, from most to least likely:

1. **Browsing to `http://<vps-ip>:8000`.** `run.py` binds to `127.0.0.1` by default, so nothing
   outside the VPS can reach it. With `--host 0.0.0.0` the page loads, but browsers turn off
   Web Crypto on plain http:// (except on localhost), so the app can't work. You need
   `https://<domain>`. That's a browser rule and can't be worked around in the code.
2. **An AAAA (IPv6) DNS record that doesn't point at the VPS.** OVH's default DNS zone
   often includes one. Let's Encrypt checks over IPv6 first, so no certificate gets
   issued, and IPv6 visitors can't connect at all. The installer only checked A records.
3. **OVHcloud Edge Network Firewall** (in the control panel) blocking 80/443 before traffic reaches ufw.
4. **Something else holding 80/443** (apache2 on some images). The installer only handled nginx.
5. **Installing with `--source` pointed at a partial folder** (like this changed-files bundle).
   `rsync --delete` then wipes `client/` and `requirements.txt`, so the install dies or
   the relay runs API-only and answers `/` with 503.

## Run this on the VPS

```bash
cd /opt/lattix/app && sudo git pull     # or copy the fixed files in
sudo bash /opt/lattix/app/deploy/vps/lattix-doctor.sh
```

It's read-only. It checks settings, relay health, whether the web client exists, proxy
config and ACME errors, 80/443 listeners, ufw, DNS A/AAAA/CAA against the VPS's real
IPs, the certificate being served, public HTTPS, and the `/ws` upgrade. Then it prints a
numbered list of fixes.

## Bugs found and fixed

### 1. Security: file-access check could be bypassed (IDOR). High
`user_can_access_file()` lets through the *sender* of any message that references a file,
and `/api/messages/file` and `/api/groups/{id}/messages/file` accepted **any** `file_id`.
So anyone who learned a file_id could post a file message referencing it and then
download the blob. Proof, before the fix: `eve claims file: 200 → eve after claim: 200 b'SECRET'`.
- `database.file_owned_by()` added. Both file-message endpoints now return 404 unless the sender uploaded the blob.
  (The client always uploads a fresh blob per send, so nothing legitimate changes.)
- `payload.file_id` is now **forced** to the checked `file_id` rather than `setdefault`. The client downloads by
  `payload.file_id`, so a mismatched value could otherwise point recipients at a different blob.
- Regression tests added to `scripts/server_test.mjs`.

### 2. Unbounded file metadata. Medium
`file_id`, `filename` and `mime` had no length limit, and `size` could be negative. They're stored
in plaintext for every file message. Now: `file_id` must be 32 hex chars, filename/mime ≤ 255 characters, and `size ≥ 0`.

### 3. API-only 503 at `/` came back as JSON. Low
The code comment said it should be plain text, but `HTTPException` rendered `{"detail": …}`. It now uses `PlainTextResponse`.

### 4. `run.py` ignored the VPS env file's variable names. Low
`/etc/lattix/lattix.env` uses `LATTIX_BIND`/`LATTIX_PORT`, but `run.py` only read
`LATTIX_HOST`/`PORT`. It now accepts both.

### 5. Installer hardening (`deploy/vps/install-debian.sh`)
- AAAA check against the VPS's actual IPv6, with a clear warning.
- apache2 stopped and disabled, and anything else found on 80/443 reported, before the proxy starts.
- `--source` refuses partial trees, and a missing `client/index.html` is flagged.
- The install state is saved **before** the certificate step, so `--update` still knows the domain if issuance fails the first time.
- The failure message points to `lattix-doctor.sh`.

### 6. Version mismatch
The bundle is 2.1.1, but everything reported 2.1.0. Bumped in `server/__init__.py` (shown by
`/api/health`), `package.json`, `client/manifest.json`, the installer metadata and the CI fallback versions.
Not changed: the wiki (`Home.md`, `_Sidebar.md`, `Release-Notes.md` still say 2.1.0 — add a 2.1.1 release note).

## Notes (not changed)
- Starlette spools the whole multipart upload before `upload_file` runs, so the chunked size check
  doesn't protect memory or disk. The proxy's `max_size`/`client_max_body_size` is the real limit. Keep it in place.
- Session tokens, presence and rate limits live in memory. That's correct for the single worker the unit
  runs. Don't add `--workers`.
- The upstream workflows still have `working-directory: Lattix`, which doesn't match the repo layout.
  The bundle's workflow files fix this, so make sure they get pushed.
