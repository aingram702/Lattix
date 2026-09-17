// Lattix relay-server tests — choosing a relay from the sign-in screen and
// Settings, running against a remote relay (optionally through a reverse
// proxy), and surviving a relay restart.
//
// The suite starts its own relays, because it needs two of them and has to
// restart one mid-test:
//
//   relay A  — plays the desktop app's bundled local relay. Its origin
//              (http://127.0.0.1:PORT_A) is where the "desktop" page loads.
//   relay B  — plays the VPS relay. By default the page reaches it directly
//              (cross-origin); set LATTIX_PROXY_BASE to reach it through a
//              real reverse proxy whose upstream is 127.0.0.1:LATTIX_RELAY_B_PORT.
//
//   node scripts/ui_test_relay.mjs
//   LATTIX_PROXY_BASE=https://lattix.test:9443 LATTIX_RELAY_B_PORT=8301 \
//     node scripts/ui_test_relay.mjs
//
// PW_CHROMIUM overrides the browser binary; PYTHON the interpreter.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_PASSWORD, dismissBackupPrompt } from "./lib/harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.env.PYTHON || "python3";
const PORT_A = Number(process.env.LATTIX_RELAY_A_PORT || 8391);
const PORT_B = Number(process.env.LATTIX_RELAY_B_PORT || 8392);
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = process.env.LATTIX_PROXY_BASE || `http://127.0.0.1:${PORT_B}`;
const HOST_B = new URL(BASE_B).host;

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "lattix-relay-test-"));
const relays = {};

async function startRelay(name, port) {
  const proc = spawn(PY, ["-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", String(port),
                          "--log-level", "warning", "--timeout-keep-alive", "75"], {
    cwd: ROOT,
    env: { ...process.env, LATTIX_DB: join(dataDir, `${name}.db`) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  relays[name] = proc;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return proc; } catch (_) {}
    await sleep(100);
  }
  throw new Error(`relay ${name} did not start`);
}
async function stopRelay(name) {
  const proc = relays[name];
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGINT");
  await Promise.race([exited, sleep(5000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

// Remember every socket URL the page opens, and keep handles to close them.
const trackSockets = () => {
  const Orig = window.WebSocket;
  window.__sockets = [];
  const Wrapped = function (...args) {
    const s = new Orig(...args);
    window.__sockets.push(s);
    return s;
  };
  Wrapped.prototype = Orig.prototype;
  Object.assign(Wrapped, Orig);
  window.WebSocket = Wrapped;
};

const askSel = '.modal[id^="ask-"]:not([hidden])';
const askButton = (page, text) => page.locator(`${askSel} button`, { hasText: text });

async function createAccount(page, username) {
  await page.waitForSelector("#create-form:not([hidden])", { timeout: 20000 });
  await page.fill("#create-username", username);
  await page.fill("#create-password", TEST_PASSWORD);
  await page.fill("#create-password2", TEST_PASSWORD);
  await page.check("#create-ack");
  await page.click("#create-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
  await dismissBackupPrompt(page);
}

async function openChat(page, who) {
  await page.click("#new-chat-btn");
  await page.fill("#search-input", who);
  await page.waitForSelector(".search-item", { timeout: 15000 });
  await page.click(".search-item");
  await page.waitForSelector("#conversation:not([hidden])");
}

async function send(page, text) {
  await page.fill("#msg-input", text);
  await page.click("#send-btn");
}

const hasText = (page, text, timeout = 20000) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll(".msg-text")].some((n) => n.textContent.includes(t)),
    text, { timeout },
  ).then(() => true, () => false);

async function relayState(page) {
  await page.waitForFunction(() => !document.querySelector("#auth-relay-dot").classList.contains("checking"),
                             null, { timeout: 15000 });
  return page.evaluate(() => ({
    host: document.querySelector("#auth-relay-host").textContent,
    state: document.querySelector("#auth-relay-state").textContent,
    on: document.querySelector("#auth-relay-dot").classList.contains("on"),
  }));
}

await startRelay("a", PORT_A);
await startRelay("b", PORT_B);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });

try {
  console.log("Lattix relay-server tests");
  console.log("=========================");
  console.log(`  relay A (local): ${BASE_A}`);
  console.log(`  relay B (remote): ${BASE_B}${process.env.LATTIX_PROXY_BASE ? " via reverse proxy" : ""}`);

  // ---------------------------------------------------------------- relay HTTP
  {
    const pre = await fetch(`${BASE_B}/api/me`, {
      method: "OPTIONS",
      headers: { Origin: `http://localhost:8000`, "Access-Control-Request-Method": "GET",
                 "Access-Control-Request-Headers": "authorization" },
    });
    ok("CORS preflight allows the desktop app's localhost origin",
       pre.headers.get("access-control-allow-origin") === "http://localhost:8000", pre.status);
    ok("CORS preflight is cacheable (max-age)", Number(pre.headers.get("access-control-max-age")) >= 600);

    const ext = await fetch(`${BASE_B}/api/health`, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    ok("CORS allows a Chrome extension origin",
       ext.headers.get("access-control-allow-origin") === "chrome-extension://abcdefghijklmnopabcdefghijklmnop");

    const evil = await fetch(`${BASE_B}/api/health`, { headers: { Origin: "https://evil.example" } });
    ok("CORS does not allow an arbitrary website", !evil.headers.get("access-control-allow-origin"));

    const h = await fetch(`${BASE_B}/api/health`);
    const body = await h.json();
    ok("API responses are marked no-store for shared caches", /no-store/.test(h.headers.get("cache-control") || ""));
    ok("health advertises first-frame WebSocket auth and pong",
       body.features?.includes("ws-auth-message") && body.features?.includes("ws-pong"));
    const idx = await fetch(`${BASE_B}/`);
    ok("static client revalidates (no-cache)", /no-cache/.test(idx.headers.get("cache-control") || ""));

    const code = await new Promise((resolve) => {
      const ws = new WebSocket(BASE_B.replace(/^http/, "ws") + "/ws");
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "not-a-token" }));
      ws.onclose = (ev) => resolve(ev.code);
      setTimeout(() => resolve("timeout"), 8000);
    });
    ok("a bad WebSocket token is refused with close code 4401 (through the proxy)", code === 4401, code);
  }

  // ------------------------------------------------ desktop page -> remote relay
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true });
  await ctxD.addInitScript(trackSockets);
  const D = await ctxD.newPage();
  const errorsD = [];
  D.on("pageerror", (e) => errorsD.push(e.message));

  await D.goto(BASE_A);
  let rs = await relayState(D);
  ok("sign-in screen shows the default relay online", rs.on && rs.host === "this server" && /online/.test(rs.state), JSON.stringify(rs));

  await D.click("#auth-relay-change");
  await D.waitForSelector("#server-modal:not([hidden])");
  ok("relay dialog opens from the sign-in screen, before any account exists", true);
  ok("URL field has focus", await D.evaluate(() => document.activeElement?.id === "server-url"));

  await D.fill("#server-url", "ftp://nope");
  ok("an unsupported scheme is rejected inline",
     await D.evaluate(() => document.querySelector("#server-hint").classList.contains("err")));
  await D.fill("#server-url", "chat.example.com/ws");
  ok("bare host gets https:// and a pasted /ws path is dropped",
     /https:\/\/chat\.example\.com$/.test(await D.textContent("#server-hint")), await D.textContent("#server-hint"));
  await D.fill("#server-url", "http://203.0.113.9:8000");
  ok("plain http:// to a public address warns",
     await D.evaluate(() => document.querySelector("#server-hint").classList.contains("warn")));

  await D.fill("#server-url", `${BASE_B}/`);
  await D.click("#server-test");
  await D.waitForSelector("#server-result.ok, #server-result.err, #server-result.warn", { timeout: 20000 });
  const testText = await D.textContent("#server-result");
  ok("Test connection reports the relay reachable", /Relay reachable/.test(testText), testText);
  ok("Test connection verifies WebSocket upgrades through the proxy", /WebSocket: working/.test(testText), testText);

  await D.click("#server-save");
  await D.waitForSelector("#server-modal", { state: "hidden", timeout: 20000 });
  rs = await relayState(D);
  ok("sign-in screen now names the remote relay and shows it online", rs.on && rs.host === HOST_B, JSON.stringify(rs));
  ok("setting is stored normalised", (await D.evaluate(() => localStorage.getItem("lattix.serverUrl"))) === BASE_B);

  const desk = u("desk");
  await createAccount(D, desk);
  ok("account created on the remote relay from a cross-origin page", true);
  const whoOnB = await fetch(`${BASE_B}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: desk, auth_secret: "x" }),
  });
  ok("the account lives on relay B (bad secret → 401, not unknown relay)", whoOnB.status === 401);

  await D.waitForFunction(() => /Connected/.test(document.querySelector("#conn-label").textContent), null, { timeout: 20000 });
  ok("status strip names the remote relay", (await D.textContent("#conn-label")).includes(HOST_B), await D.textContent("#conn-label"));
  const urls = await D.evaluate(() => window.__sockets.map((s) => s.url));
  ok("WebSocket goes to the remote relay", urls.length > 0 && urls.every((x) => x.includes(HOST_B)), urls.join(","));
  ok("session token is never put in the WebSocket URL", urls.every((x) => !/token=/.test(x)), urls.join(","));

  // Share link must point at the shared relay, not http://127.0.0.1:PORT_A.
  await D.click("#share-btn");
  await D.waitForSelector("#share-modal:not([hidden])");
  const share = await D.inputValue("#share-url-input");
  ok("share link uses the remote relay's address", share.startsWith(BASE_B + "/#add="), share);
  await D.keyboard.press("Escape");

  // Settings section is visible in a normal (non-extension) build.
  await D.click("#settings-btn");
  await D.waitForSelector("#settings-modal:not([hidden])");
  ok("Settings shows the Relay server section", await D.isVisible("#server-section"));
  ok("Settings names the relay in use", (await D.textContent("#server-current")) === HOST_B);
  await D.click("#server-change-btn");
  await D.waitForSelector("#server-modal:not([hidden])");
  ok("Change… opens the relay dialog over Settings, prefilled",
     (await D.inputValue("#server-url")) === BASE_B && await D.isVisible("#settings-modal"));
  await D.keyboard.press("Escape");
  await D.waitForSelector("#server-modal", { state: "hidden" });
  ok("Escape closes only the relay dialog", await D.isVisible("#settings-modal"));
  await D.keyboard.press("Escape");

  // ------------------------------------------- a peer on the relay's own web app
  const ctxP = await browser.newContext({ ignoreHTTPSErrors: true });
  const P = await ctxP.newPage();
  await P.goto(BASE_B);
  const peer = u("vpspeer");
  await createAccount(P, peer);

  await openChat(D, peer);
  await send(D, "hello over the proxy");
  await P.waitForSelector(`#contacts .contact:has-text("${desk}")`, { timeout: 20000 });
  await P.click(`#contacts .contact:has-text("${desk}")`);
  ok("peer receives the desktop user's message", await hasText(P, "hello over the proxy"));
  await send(P, "reply in real time");
  ok("desktop user receives the reply live over the proxied WebSocket", await hasText(D, "reply in real time"));

  // ----------------------------------------------------------- relay restart
  // Restarting wipes every in-memory session token. Clients must log back in
  // on their own, reconnect, and fetch what was sent while they were away.
  const socketsBefore = await D.evaluate(() => window.__sockets.length);
  await stopRelay("b");
  await D.waitForFunction(() => /Reconnecting/.test(document.querySelector("#conn-label").textContent), null, { timeout: 30000 });
  ok("client notices the relay went away", true);
  await startRelay("b", PORT_B);

  await send(P, "sent after the relay restarted");
  ok("peer's send succeeds after restart (automatic re-login on 401)", await hasText(P, "sent after the relay restarted"));
  await D.waitForFunction(() => /Connected/.test(document.querySelector("#conn-label").textContent), null, { timeout: 45000 })
    .catch(() => {});
  ok("desktop client reconnects after the restart", /Connected/.test(await D.textContent("#conn-label")));
  ok("reconnect opened a new socket", (await D.evaluate(() => window.__sockets.length)) > socketsBefore);
  ok("message sent during the outage is delivered (resync or live)", await hasText(D, "sent after the relay restarted", 30000));
  ok("no 'signed out' prompt after a routine restart", (await D.locator(askSel).count()) === 0);

  // Message pushed while the socket is down must be fetched on reconnect.
  await D.evaluate(() => {
    const WS = window.WebSocket;
    window.__blockSockets = true;
    // Hold the next reconnect back for a moment so the peer's message is
    // definitely pushed while this client has no socket.
    window.WebSocket = function (...a) {
      if (window.__blockSockets) throw new Error("blocked for test");
      return new WS(...a);
    };
    window.WebSocket.prototype = WS.prototype;
    Object.assign(window.WebSocket, WS);
    window.__sockets.at(-1)?.close();
  });
  await D.waitForFunction(() => /Reconnecting/.test(document.querySelector("#conn-label").textContent), null, { timeout: 10000 });
  await send(P, "pushed while you were offline");
  await hasText(P, "pushed while you were offline");
  await sleep(1000);
  ok("offline client hasn't seen it yet", !(await hasText(D, "pushed while you were offline", 500)));
  await D.evaluate(() => { window.__blockSockets = false; });
  await D.click("#conn-status");
  ok("missed message is fetched after reconnecting", await hasText(D, "pushed while you were offline", 30000));

  // --------------------------------------------- moving an identity to relay B
  // An account made on the local relay, whose user then points Lattix at the
  // VPS, is offered to register the same identity there.
  const ctxM = await browser.newContext({ ignoreHTTPSErrors: true });
  const M = await ctxM.newPage();
  await M.goto(BASE_A);
  const mover = u("mover");
  await createAccount(M, mover);
  const fpBefore = await M.evaluate(() => document.querySelector("#self-fingerprint")?.textContent || "");
  await M.click("#settings-btn");
  await M.waitForSelector("#settings-modal:not([hidden])");
  await M.click("#server-change-btn");
  await M.fill("#server-url", BASE_B);
  await M.click("#server-save");
  await askButton(M, "Switch and reload").waitFor({ timeout: 20000 });
  ok("switching relay while signed in asks for confirmation", true);
  await Promise.all([M.waitForNavigation(), askButton(M, "Switch and reload").click()]);
  await M.waitForSelector("#unlock-form:not([hidden])", { timeout: 20000 });
  rs = await relayState(M);
  ok("after reload the sign-in screen targets the new relay", rs.host === HOST_B && rs.on, JSON.stringify(rs));

  await M.fill("#unlock-password", TEST_PASSWORD);
  await M.click("#unlock-form button[type=submit]");
  await askButton(M, "Register here").waitFor({ timeout: 60000 });
  ok("unlocking an identity the new relay doesn't know offers to register it", true);
  await askButton(M, "Register here").click();
  await M.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
  ok("identity registered and app booted on the new relay", true);
  await M.waitForFunction(() => document.querySelector("#self-fingerprint")?.textContent.trim(), null, { timeout: 20000 });
  const fpAfter = await M.evaluate(() => document.querySelector("#self-fingerprint")?.textContent || "");
  ok("same identity (fingerprint unchanged)", fpBefore === fpAfter, `${fpBefore} vs ${fpAfter}`);

  // ------------------------------------------ unreachable relay, fail fast
  const ctxU = await browser.newContext();
  const U = await ctxU.newPage();
  await U.goto(BASE_A);
  await U.evaluate(() => localStorage.setItem("lattix.serverUrl", "http://127.0.0.1:9"));
  await U.reload();
  rs = await relayState(U);
  ok("an unreachable relay shows as unreachable on the sign-in screen", !rs.on && /unreachable/.test(rs.state), JSON.stringify(rs));
  await U.fill("#create-username", u("nobody"));
  await U.fill("#create-password", TEST_PASSWORD);
  await U.fill("#create-password2", TEST_PASSWORD);
  await U.check("#create-ack");
  const t0 = Date.now();
  await U.click("#create-form button[type=submit]");
  await askButton(U, "Relay settings").waitFor({ timeout: 15000 });
  ok(`creating an account fails fast with a relay prompt (${Date.now() - t0} ms)`, Date.now() - t0 < 12000);
  await askButton(U, "Relay settings").click();
  ok("the prompt leads straight to the relay dialog",
     await U.waitForSelector("#server-modal:not([hidden])", { timeout: 5000 }).then(() => true, () => false));
  await U.click("#server-reset");
  await U.click("#server-save");
  await U.waitForSelector("#server-modal", { state: "hidden", timeout: 20000 });
  rs = await relayState(U);
  ok("Use default returns to the bundled relay", rs.on && rs.host === "this server"
     && (await U.evaluate(() => localStorage.getItem("lattix.serverUrl"))) === null, JSON.stringify(rs));

  ok("no uncaught page errors", errorsD.length === 0, errorsD.join(" | "));
} catch (err) {
  fail++;
  console.log("  ✗ suite crashed:", err);
} finally {
  await browser.close();
  await stopRelay("a");
  await stopRelay("b");
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
