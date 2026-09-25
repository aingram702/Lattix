// Browser tests for key trust (2.2): computed fingerprints, pinning,
// share-link verification, the key-change banner and send gating — plus
// history paging past one page and encrypted file names.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_trust.mjs
//
// Remote parties are driven straight through the API with the real client
// crypto module; "bob" is the browser. PW_CHROMIUM overrides the browser.

import { chromium } from "playwright";
import * as C from "../client/js/crypto.js";
import { signUp, unlock, TEST_PASSWORD } from "./lib/harness.mjs";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); }
};
const sfx = Date.now().toString(36) + Math.floor(Math.random() * 1000);

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (res.headers.get("content-type") || "").includes("json") ? res.json() : res;
}
async function remoteUser(username) {
  const id = await C.generateIdentity();
  id.username = username;
  const t = await api("POST", "/api/register", { body: {
    username, kem_public_key: id.kem.publicKey, dsa_public_key: id.dsa.publicKey,
    fingerprint: id.fingerprint, auth_secret: id.authSecret } });
  return { id, username, token: t.token };
}
async function sendText(from, toName, text) {
  const to = await api("GET", `/api/users/${toName}`, { token: from.token });
  const rec = [{ username: toName, kemPub: to.kem_public_key }, { username: from.username, kemPub: from.id.kem.publicKey }];
  const payload = await C.encryptMessage(text, rec, from.id.dsa.secretKey);
  return api("POST", "/api/messages", { token: from.token, body: { recipient: toName, payload } });
}

// Reload onto a share link and unlock.
async function openLink(page, who, fp) {
  await page.goto(`${BASE}/#add=${who}&fp=${fp}`);
  await page.reload();
  await unlock(page);
  await page.waitForSelector("#conversation:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(800);
}
async function reopen(page, who) {
  await page.goto(BASE);
  await page.reload();
  await unlock(page);
  await page.locator(".contact", { hasText: who }).first().click();
  await page.waitForSelector("#conversation:not([hidden])");
  await page.waitForTimeout(800);
}
const bannerShown = (page) => page.locator("#key-banner:not([hidden])").count().then((n) => n > 0);
const askButton = (page, text) => page.locator('.modal[id^="ask-"]:not([hidden]) button', { hasText: text });

console.log("\nLattix trust & paging UI tests\n==============================");

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const bob = "bob" + sfx;
await signUp(page, bob, BASE);

try {
  // ------------------------------------------------ share link that matches
  console.log("\n— share link with a matching code");
  const alice = await remoteUser("alice" + sfx);
  await openLink(page, alice.username, alice.id.fingerprint);
  ok("no warning when the link's code matches the relay's keys", !(await bannerShown(page)));
  const pins = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("lattix.pins."));
    return k ? JSON.parse(localStorage.getItem(k)) : {};
  });
  ok("the contact is pinned as verified from the link", pins[alice.username]?.verified === true &&
     pins[alice.username]?.fp === alice.id.fingerprint);
  await page.click("#verify-peer-btn");
  await page.waitForSelector("#fp-modal:not([hidden])");
  const shown = (await page.textContent("#fp-value")).replace(/\s/g, "").toLowerCase();
  ok("the Verify dialog shows the code of the keys in use", shown === alice.id.fingerprint);
  ok("the Verify dialog says Verified", (await page.textContent("#fp-status")).includes("Verified"));
  await page.click("#fp-close");

  await sendText(alice, bob, "hello from the real alice");
  await page.waitForSelector(".bubble.theirs .msg-text", { timeout: 15000 });
  ok("a message from the verified key shows as verified",
     (await page.locator(".bubble.theirs .verified").count()) > 0);

  // ------------------------------------------------ verified contact changes key
  console.log("\n— verified contact's key changes");
  await api("DELETE", "/api/me", { token: alice.token });
  const alice2 = await remoteUser(alice.username);          // same name, new keys
  await sendText(alice2, bob, "new device, who dis");
  await reopen(page, alice.username);
  ok("the red key-change banner appears", await bannerShown(page));
  ok("the banner explains that the code changed",
     (await page.textContent("#key-banner-text")).includes("Safety code changed"));
  await page.waitForSelector(".bubble.theirs", { timeout: 15000 });
  const lastMeta = page.locator(".bubble.theirs").last().locator(".unverified");
  ok("messages from the changed key are not shown as verified", (await lastMeta.count()) > 0);

  await page.fill("#msg-input", "are you really alice?");
  await page.click("#send-btn");
  await page.waitForTimeout(700);
  ok("sending is held while the change is unreviewed",
     (await page.inputValue("#msg-input")).includes("are you really alice?"));
  ok("the user is told why", (await page.locator(".toast", { hasText: "needs review" }).count()) > 0);

  await page.click("#verify-peer-btn");
  await page.waitForSelector("#fp-modal:not([hidden])");
  ok("the Verify dialog shows the previously verified code",
     (await page.textContent("#fp-status")).includes("Changed"));
  ok("…and the new code", (await page.textContent("#fp-value")).replace(/\s/g, "").toLowerCase() === alice2.id.fingerprint);
  await page.click("#fp-close");

  await page.click("#key-banner-accept");
  await askButton(page, "Accept new code").click();
  await page.waitForTimeout(400);
  ok("accepting the new code clears the banner", !(await bannerShown(page)));
  await page.click("#send-btn");
  await page.waitForTimeout(1500);
  ok("sending works after accepting", (await page.inputValue("#msg-input")) === "");

  // ------------------------------------------------ share link that doesn't match (MITM)
  console.log("\n— share link with a mismatched code");
  const carol = await remoteUser("carol" + sfx);
  const impostor = await C.generateIdentity();             // the code carol "really" has
  await page.goto(`${BASE}/#add=${carol.username}&fp=${impostor.fingerprint}`);
  await page.reload();
  await unlock(page);
  await askButton(page, "Close").waitFor({ timeout: 15000 });
  ok("a mismatch raises a warning dialog",
     (await page.locator('.modal[id^="ask-"]:not([hidden]) h3').textContent()).includes("mismatch"));
  await askButton(page, "Close").click();
  ok("…and the banner", await bannerShown(page));
  ok("the banner names a mismatch", (await page.textContent("#key-banner-text")).includes("mismatch"));
  await page.fill("#msg-input", "secret");
  await page.click("#send-btn");
  await page.waitForTimeout(700);
  ok("nothing is sent to a mismatched key", (await page.inputValue("#msg-input")).includes("secret"));
  await page.fill("#msg-input", "");

  // ------------------------------------------------ history paging
  console.log("\n— history past one page");
  const health = await api("GET", "/api/health");
  const pageSize = health.history_page_size || 500;
  const dave = await remoteUser("dave" + sfx);
  const to = await api("GET", `/api/users/${bob}`, { token: dave.token });
  const rec = [{ username: bob, kemPub: to.kem_public_key }, { username: dave.username, kemPub: dave.id.kem.publicKey }];
  const total = pageSize + 20;
  const payload = await C.encryptMessage("bulk", rec, dave.id.dsa.secretKey);
  for (let i = 0; i < total - 1; i++) {
    await api("POST", "/api/messages", { token: dave.token, body: { recipient: bob, payload } });
  }
  await sendText(dave, bob, "the very last message");
  await reopen(page, dave.username);
  await page.waitForFunction(() => document.querySelectorAll("#messages .bubble").length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const lastText = await page.locator(".bubble .msg-text").last().textContent();
  ok(`the newest of ${total} messages is loaded`, lastText.includes("the very last message"), lastText);
  const earlier = await page.locator(".load-earlier").textContent().catch(() => "");
  const hidden = Number((earlier.match(/\((\d+) more\)/) || [])[1] || 0);
  ok(`all ${total} messages are in history`, hidden + 200 === total, earlier);

  // ------------------------------------------------ encrypted file names
  console.log("\n— encrypted file names");
  const name = `quarterly-${sfx}.txt`;
  const bytes = new TextEncoder().encode("file body");
  const { cipherBytes, payload: fp } = await C.encryptFile(bytes, { filename: name, mime: "text/plain", size: bytes.length },
                                                           rec, dave.id.dsa.secretKey);
  const form = new FormData();
  form.append("file", new Blob([cipherBytes]), "blob");
  form.append("size", String(bytes.length));
  const up = await api("POST", "/api/files", { token: dave.token, form });
  const env = await api("POST", "/api/messages/file", { token: dave.token, body: {
    recipient: bob, file_id: up.file_id, filename: "file", mime: "application/octet-stream", size: bytes.length, payload: fp } });
  ok("the relay's copy of the envelope doesn't contain the name", !JSON.stringify(env).includes(name));
  await page.waitForSelector(`.file-name:text("${name}")`, { timeout: 15000 });
  ok("the recipient sees the real file name", true);

  // ------------------------------------------------ vault work-factor upgrade
  console.log("\n— vault upgrade on unlock");
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("lattix.vault")));
  const identity = await C.openVault(stored, TEST_PASSWORD);
  const legacy = await legacySealVault(identity, TEST_PASSWORD);
  await page.evaluate((v) => localStorage.setItem("lattix.vault", v), JSON.stringify(legacy));
  await page.goto(BASE);
  await page.reload();
  await unlock(page);
  ok("a 2.1.x vault (250k iterations) still unlocks", true);
  let upgraded = null;
  for (let i = 0; i < 40 && !upgraded; i++) {
    await page.waitForTimeout(250);
    const v = JSON.parse(await page.evaluate(() => localStorage.getItem("lattix.vault")));
    if (v.iter === C.VAULT_ITERATIONS) upgraded = v;
  }
  ok("it is re-sealed at the current work factor after unlock", !!upgraded);
  const reopened = upgraded && await C.openVault(upgraded, TEST_PASSWORD);
  ok("the upgraded vault holds the same identity", reopened && reopened.fingerprint === identity.fingerprint &&
     reopened.kem.secretKey === identity.kem.secretKey && !("avatar" in reopened));

  ok("no uncaught page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  fail++;
  console.log("  ✗ suite aborted:", err.message.split("\n")[0]);
}

await browser.close();

async function legacySealVault(identity, password) {
  const te = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
                                            base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(identity))));
  return { v: 1, salt: C.bytesToB64(salt), iv: C.bytesToB64(iv), ciphertext: C.bytesToB64(ct) };
}
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
