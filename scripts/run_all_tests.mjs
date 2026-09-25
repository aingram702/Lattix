// Run every Lattix test suite against one relay and report a single verdict.
//
//   pip install -r requirements.txt
//   npm install && npx playwright install chromium
//   node scripts/run_all_tests.mjs
//
// Starts its own relay on a scratch database unless LATTIX_BASE points at one
// that is already running. Auth rate limiting is disabled for the child relay:
// the suites create dozens of accounts from one IP in a few minutes, which the
// production default (10 per 5 minutes) is meant to stop.
//
// Set PW_CHROMIUM to use a Chromium you already have instead of Playwright's.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = Number(process.env.LATTIX_TEST_PORT || 8111);
const OWN_RELAY = !process.env.LATTIX_BASE;
const BASE = process.env.LATTIX_BASE || `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.PYTHON || "python3";

const SUITES = [
  "db_test.py",
  "integration_test.mjs",
  "server_test.mjs",
  "regression_test.mjs",
  "ui_test.mjs",
  "ui_test_auth.mjs",
  "ui_test_sidebar.mjs",
  "ui_test_composer.mjs",
  "ui_test_dialogs.mjs",
  "ui_test_media.mjs",
  "ui_test_theme.mjs",
  "ui_test_a11y.mjs",
  "ui_test_perf.mjs",
  "ui_test_relay.mjs",
  "ui_test_trust.mjs",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRelay(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

function runSuite(name) {
  return new Promise((resolve) => {
    // .py suites (the database layer) run under the same Python as the relay.
    const cmd = name.endsWith(".py") ? PYTHON : process.execPath;
    const child = spawn(cmd, [join(HERE, name)], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, LATTIX_BASE: BASE },
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

let relay = null;
let dataDir = null;

function stopRelay() {
  if (relay && !relay.killed) { try { relay.kill("SIGTERM"); } catch (_) {} }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }
  relay = null;
  dataDir = null;
}
process.on("exit", stopRelay);
process.on("SIGINT", () => { stopRelay(); process.exit(130); });

if (OWN_RELAY) {
  dataDir = mkdtempSync(join(tmpdir(), "lattix-test-"));
  console.log(`Starting a relay on ${BASE} (database in ${dataDir})`);
  relay = spawn(PYTHON, ["-m", "uvicorn", "server.main:app",
                         "--host", "127.0.0.1", "--port", String(PORT),
                         "--log-level", "warning"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LATTIX_DB: join(dataDir, "lattix.db"),
      LATTIX_RATE_LIMIT_MAX: "0",
    },
  });
  relay.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\nThe relay exited with code ${code} — is FastAPI installed?`);
    }
  });
}

if (!(await waitForRelay())) {
  console.error(`\nNo relay answering at ${BASE}. Start one, or let this script do it.`);
  stopRelay();
  process.exit(1);
}

const failed = [];
for (const suite of SUITES) {
  console.log(`\n=== ${suite} ${"=".repeat(Math.max(0, 60 - suite.length))}`);
  if (!(await runSuite(suite))) failed.push(suite);
}

stopRelay();

console.log(`\n${"=".repeat(64)}`);
if (failed.length) {
  console.log(`FAILED (${failed.length}/${SUITES.length}): ${failed.join(", ")}\n`);
  process.exit(1);
}
console.log(`All ${SUITES.length} suites passed.\n`);
