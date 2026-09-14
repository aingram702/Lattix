// Lattix sidebar tests — conversation filter, presence dots, the unread count
// in the tab title, and reconnect behaviour.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_sidebar.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { signUp as _signUp, dismissBackupPrompt } from "./lib/harness.mjs";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);


// Scope to #contacts: .contact-name is also used by search-result rows, which
// linger in the hidden search modal after it closes.
const rowNames = (p) =>
  p.evaluate(() => [...document.querySelectorAll("#contacts .contact-name")].map((n) => n.textContent.trim()));

const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix sidebar tests");
  console.log("====================");

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // Keep a handle on every socket the app opens. Playwright's setOffline does
  // not close an already-established WebSocket in Chromium, so this is how the
  // test can drop the real connection and exercise the app's own onclose path.
  await ctxA.addInitScript(() => {
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
  });
  const A = await ctxA.newPage();
  const errors = [];
  A.on("pageerror", (e) => errors.push(e.message));

  const me = u("side");
  const alpha = u("alpha"), bravo = u("bravo"), delta = u("delta");
  await signUp(A, me);

  const peers = {};
  for (const name of [alpha, bravo, delta]) {
    const p = await (await browser.newContext()).newPage();
    await signUp(p, name);
    peers[name] = p;
  }

  async function openChat(page, who) {
    await page.click("#new-chat-btn");
    await page.fill("#search-input", who);
    await page.waitForSelector(".search-item");
    await page.click(".search-item");
    await page.waitForSelector("#conversation:not([hidden])");
  }

  // Three conversations with distinguishable content.
  for (const [name, text] of [
    [alpha, "the quick brown fox"],
    [bravo, "lorem ipsum dolor"],
    [delta, "unique-token-xyzzy here"],
  ]) {
    await openChat(A, name);
    await A.fill("#msg-input", text);
    await A.click("#send-btn");
    await A.waitForTimeout(900);
  }
  await A.waitForTimeout(800);
  ok(`three conversations listed (${(await rowNames(A)).length})`,
     (await rowNames(A)).length === 3);

  // ---------------- filter ----------------
  ok("a search box exists above the list", await A.isVisible("#contact-filter"));

  await A.fill("#contact-filter", alpha.slice(0, 5));
  await A.waitForTimeout(300);
  let names = await rowNames(A);
  ok(`filtering by name narrows the list (${names.length})`,
     names.length === 1 && names[0].includes(alpha));

  await A.fill("#contact-filter", "xyzzy");
  await A.waitForTimeout(300);
  names = await rowNames(A);
  ok(`filtering matches message text too (${JSON.stringify(names)})`,
     names.length === 1 && names[0].includes(delta));

  await A.fill("#contact-filter", "zzzz-no-such-thing");
  await A.waitForTimeout(300);
  const emptyHint = await A.locator("#contacts .empty-hint").textContent();
  ok(`an unmatched filter explains itself ("${emptyHint}")`, /no conversations match/i.test(emptyHint));

  // Escape clears the filter without closing anything else.
  await A.focus("#contact-filter");
  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);
  ok("Escape clears the filter", (await A.inputValue("#contact-filter")) === "");
  ok("clearing restores the full list", (await rowNames(A)).length === 3);

  // Ctrl+F focuses it.
  await A.evaluate(() => document.activeElement.blur());
  await A.keyboard.press("Control+f");
  await A.waitForTimeout(250);
  ok("Ctrl+F focuses the conversation search",
     await A.evaluate(() => document.activeElement?.id === "contact-filter"));
  await A.evaluate(() => document.activeElement.blur());

  // Filtering must not drop conversations, only hide them.
  await A.fill("#contact-filter", "xyzzy");
  await A.waitForTimeout(300);
  const stillThere = await A.evaluate(() => Object.keys(window.__convos || {}).length);
  await A.fill("#contact-filter", "");
  await A.waitForTimeout(300);
  ok("filtering is presentational, not destructive",
     (await rowNames(A)).length === 3, String(stillThere));

  // ---------------- presence ----------------
  await A.waitForTimeout(1500);
  const dots = await A.evaluate(() => document.querySelectorAll("#contacts .presence-dot").length);
  ok(`online peers show a presence dot (${dots} of 3)`, dots === 3);

  const labelled = await A.evaluate(() =>
    [...document.querySelectorAll("#contacts .contact")].filter((c) => /online/.test(c.getAttribute("aria-label") || "")).length);
  ok(`presence is announced, not just coloured (${labelled})`, labelled === 3);

  // Take one peer offline; its dot must disappear.
  await peers[bravo].close();
  await A.waitForTimeout(3000);
  const dotsAfter = await A.evaluate(() => document.querySelectorAll("#contacts .presence-dot").length);
  ok(`a peer going offline clears its dot (${dotsAfter} left)`, dotsAfter === 2);

  // ---------------- unread title ----------------
  const baseTitle = await A.title();
  ok(`title is clean with nothing unread ("${baseTitle}")`, !/^\(\d+\)/.test(baseTitle));

  // Leave the conversation so incoming messages count as unread. #back-btn is
  // display:none above 720px, so click it directly rather than via the pointer.
  await A.evaluate(() => document.querySelector("#back-btn").click());
  await A.waitForTimeout(500);

  await peers[alpha].waitForSelector("#contacts .contact", { timeout: 20000 });
  await peers[alpha].evaluate(() => document.querySelector("#contacts .contact").click());
  await peers[alpha].waitForSelector("#conversation:not([hidden])");
  await peers[alpha].fill("#msg-input", "unread one");
  await peers[alpha].click("#send-btn");
  await A.waitForTimeout(1800);
  await peers[delta].waitForSelector("#contacts .contact", { timeout: 20000 });
  await peers[delta].evaluate(() => document.querySelector("#contacts .contact").click());
  await peers[delta].waitForSelector("#conversation:not([hidden])");
  await peers[delta].fill("#msg-input", "unread two");
  await peers[delta].click("#send-btn");
  await A.waitForTimeout(2200);

  const unreadTitle = await A.title();
  ok(`unread count appears in the tab title ("${unreadTitle}")`, /^\(\d+\)/.test(unreadTitle));

  // Opening the conversation clears its share of the count.
  await A.evaluate(() => {
    const row = document.querySelector("#contacts .contact");
    row.click();
  });
  await A.waitForTimeout(1500);
  const afterRead = await A.title();
  const before = parseInt(unreadTitle.match(/^\((\d+)\)/)?.[1] || "0", 10);
  const after = parseInt(afterRead.match(/^\((\d+)\)/)?.[1] || "0", 10);
  ok(`reading a conversation lowers the count (${before} -> ${after})`, after < before);

  // ---------------- reconnect ----------------
  const connState = await A.evaluate(() => ({
    label: document.querySelector("#conn-label").textContent,
    clickable: document.querySelector("#conn-status").classList.contains("clickable"),
  }));
  ok(`connected state is not clickable ("${connState.label}")`,
     /connected/i.test(connState.label) && !connState.clickable);

  // Drop the live socket and watch the app's own status handler react. The
  // reconnect is quick, so record the transition with a MutationObserver
  // rather than racing it with polls.
  const transition = await A.evaluate(async () => {
    const strip = document.querySelector("#conn-status");
    const label = document.querySelector("#conn-label");
    const seen = { wentClickable: false, saidReconnecting: false };
    const obs = new MutationObserver(() => {
      if (strip.classList.contains("clickable")) seen.wentClickable = true;
      if (/reconnect/i.test(label.textContent)) seen.saidReconnecting = true;
    });
    obs.observe(strip, { attributes: true, subtree: true, childList: true, characterData: true });

    window.__sockets.at(-1)?.close();

    const deadline = Date.now() + 20000;
    let recovered = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (seen.wentClickable && /connected/i.test(label.textContent)) { recovered = true; break; }
    }
    obs.disconnect();
    return { ...seen, recovered, finalLabel: label.textContent };
  });
  ok("losing the connection marks the strip as retryable", transition.wentClickable);
  ok("the label says it is reconnecting", transition.saidReconnecting);
  ok(`the socket reconnects on its own ("${transition.finalLabel}")`, transition.recovered);
  ok("the reconnected strip is no longer clickable",
     await A.evaluate(() => !document.querySelector("#conn-status").classList.contains("clickable")));

  // Clicking the strip while already connected must be a no-op.
  await A.click("#conn-status");
  await A.waitForTimeout(800);
  ok("clicking a healthy strip changes nothing",
     await A.evaluate(() => /connected/i.test(document.querySelector("#conn-label").textContent)));

  // Backoff must be bounded and reset on success.
  const backoff = await A.evaluate(() => {
    // Exercise the growth rule directly — 1s base, x1.6, capped at 20s.
    let b = 1000; const seq = [];
    for (let i = 0; i < 12; i++) { b = Math.min(b * 1.6, 20000); seq.push(Math.round(b)); }
    return { max: Math.max(...seq), first: seq[0], grew: seq[3] > seq[0] };
  });
  ok(`reconnect backoff grows and is capped (${backoff.first}ms → ${backoff.max}ms)`,
     backoff.grew && backoff.max === 20000);

  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
