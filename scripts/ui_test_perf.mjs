// Lattix performance tests — render batching, boot cost, the render window,
// and the disappearing-message sweep.
//
// These assert *behaviour* (how many full DOM rebuilds happen, whether the
// list is capped) rather than wall-clock, so they stay meaningful on a loaded
// CI box. Timings are printed for context but not asserted on.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_perf.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { signUp as _signUp, unlock, TEST_PASSWORD } from "./lib/harness.mjs";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);
const signUp = (page, username) => _signUp(page, username, BASE);

// Count full rebuilds of a container by watching for its children being
// replaced wholesale. Each renderMessages/renderContacts call clears and
// refills, so one "rebuild" == one render pass.
const COUNTER = `(sel) => {
  const node = document.querySelector(sel);
  const state = { rebuilds: 0 };
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.removedNodes.length && r.target === node) { state.rebuilds++; return; }
    }
  });
  obs.observe(node, { childList: true });
  return state;
}`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix performance tests");
  console.log("========================");

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const errors = [];
  A.on("pageerror", (e) => errors.push(e.message));

  const me = u("perf"), peer = u("perfpeer");
  await signUp(A, me);
  const B = await (await browser.newContext()).newPage();
  await signUp(B, peer);

  await A.click("#new-chat-btn");
  await A.fill("#search-input", peer);
  await A.waitForSelector(".search-item");
  await A.click(".search-item");
  await A.fill("#msg-input", "opening the conversation");
  await A.click("#send-btn");
  await A.waitForSelector(".bubble.mine");
  await A.waitForTimeout(600);

  await B.waitForSelector("#contacts .contact", { timeout: 20000 });
  await B.evaluate(() => document.querySelector("#contacts .contact").click());
  await B.waitForSelector("#conversation:not([hidden])");

  // ---------------- seed a long history ----------------
  const TARGET = 300;
  const already = await A.evaluate(() => document.querySelectorAll(".bubble").length);
  const toSend = Math.max(0, TARGET - already);
  console.log(`      (seeding ${toSend} messages…)`);
  await B.evaluate(async (n) => {
    const input = document.querySelector("#msg-input");
    const btn = document.querySelector("#send-btn");
    for (let i = 0; i < n; i++) {
      input.value = "bulk " + i;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      btn.click();
      await new Promise((r) => setTimeout(r, 60));
    }
  }, toSend);
  await A.waitForTimeout(8000);

  // ---------------- the render window ----------------
  const windowed = await A.evaluate(() => {
    const btn = document.querySelector(".load-earlier");
    const more = btn && /\((\d+) more\)/.exec(btn.textContent);
    return {
      rendered: document.querySelectorAll(".bubble").length,
      hidden: more ? Number(more[1]) : null,
      hasLoadEarlier: !!btn,
    };
  });
  const held = windowed.hidden === null ? null : windowed.hidden + windowed.rendered;
  console.log(`      (holding ${held ?? "?"} messages, rendering ${windowed.rendered})`);
  ok(`the rendered list is capped (${windowed.rendered} nodes)`, windowed.rendered <= 260);
  ok("a way to load earlier messages is offered", windowed.hasLoadEarlier);
  ok(`nothing was dropped from state (${held} held vs ${windowed.rendered} rendered)`,
     held !== null && held >= TARGET - 5);

  // Loading earlier must reveal more without losing position.
  const before = windowed.rendered;
  await A.click(".load-earlier");
  await A.waitForTimeout(1200);
  const after = await A.evaluate(() => document.querySelectorAll(".bubble").length);
  ok(`"load earlier" reveals more history (${before} -> ${after})`, after > before);

  // ---------------- boot: replay cost ----------------
  // Boot decrypts and ingests the whole history in a tight loop. That is the
  // burst that matters: unbatched it is one full rebuild of the message list
  // and of the sidebar per envelope, which is quadratic in history length.
  // A live trickle of messages arriving seconds apart legitimately renders
  // once each — there is nothing to coalesce there — so this is measured at
  // boot rather than by sending slowly from a peer.
  await A.addInitScript(() => {
    window.__counts = { msgs: 0, contacts: 0 };
    const watch = () => {
      for (const [key, sel] of [["msgs", "#messages"], ["contacts", "#contacts"]]) {
        const node = document.querySelector(sel);
        if (!node) continue;
        new MutationObserver((records) => {
          for (const r of records) {
            if (r.removedNodes.length && r.target === node) { window.__counts[key]++; return; }
          }
        }).observe(node, { childList: true });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", watch, { once: true });
    } else watch();
  });

  const t0 = Date.now();
  await A.reload();
  await A.waitForSelector("#unlock-form:not([hidden])", { timeout: 20000 });
  await A.fill("#unlock-password", TEST_PASSWORD);
  await A.click("#unlock-form button[type=submit]");
  await A.waitForSelector("#app-screen:not([hidden])", { timeout: 90000 });
  await A.waitForFunction(() => document.querySelectorAll("#contacts .contact").length > 0,
    null, { timeout: 90000 });
  await A.waitForTimeout(2500);
  const bootMs = Date.now() - t0;

  const boot = await A.evaluate(() => ({
    ...window.__counts,
    bubbles: document.querySelectorAll(".bubble").length,
  }));
  console.log(`      (boot replaying ${TARGET} messages: ${bootMs}ms, ` +
              `${boot.msgs} message renders, ${boot.contacts} sidebar renders)`);
  ok(`replaying ${TARGET} messages does not cost a render each (${boot.msgs} message renders)`,
     boot.msgs < TARGET / 4);
  ok(`the sidebar is coalesced too (${boot.contacts} renders)`, boot.contacts < TARGET / 4);
  // Boot lands on the empty state, so open the conversation before checking
  // that the replayed history is actually present.
  await A.evaluate(() => document.querySelector("#contacts .contact").click());
  await A.waitForTimeout(2000);
  const afterOpen = await A.evaluate(() => document.querySelectorAll(".bubble").length);
  ok(`the replayed history is intact and windowed (${afterOpen} rendered)`,
     afterOpen > 0 && afterOpen <= 260);
  console.log(`      (boot with a ${TARGET}-message conversation: ${bootMs}ms)`);
  ok(`boot completes with a large history (${bootMs}ms)`, bootMs < 90000);

  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---------------- disappearing messages still expire ----------------
  {
    const ctx = await browser.newContext();
    const X = await ctx.newPage();
    const Y = await (await browser.newContext()).newPage();
    const xn = u("ttlx"), yn = u("ttly");
    await signUp(X, xn);
    await signUp(Y, yn);

    await X.click("#new-chat-btn");
    await X.fill("#search-input", yn);
    await X.waitForSelector(".search-item");
    await X.click(".search-item");

    // Set the shortest timer through the conversation menu.
    await X.click("#menu-btn");
    await X.waitForTimeout(250);
    await X.locator("#chat-menu button", { hasText: "Disappearing" }).click();
    await X.waitForTimeout(350);
    await X.locator(".ttl-opt", { hasText: "30 sec" }).click();
    await X.waitForTimeout(350);

    await X.fill("#msg-input", "this should vanish");
    await X.click("#send-btn");
    await X.waitForSelector(".bubble.mine", { timeout: 20000 });
    ok("a disappearing message is delivered", (await X.locator(".bubble").count()) >= 1);

    // Rather than waiting 30s, move the client's clock past the expiry and let
    // the sweep run: the point is that expiry no longer relies on a timer
    // registered per message at ingest time.
    const gone = await X.evaluate(async () => {
      const shift = 60_000;
      const RealDate = Date;
      // eslint-disable-next-line no-global-assign
      Date = class extends RealDate {
        constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); }
        static now() { return RealDate.now() + shift; }
      };
      const deadline = RealDate.now() + 45000;
      while (RealDate.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (document.querySelectorAll(".bubble").length === 0) return true;
      }
      return false;
    });
    ok("it is swept once its expiry passes", gone);
    await ctx.close();
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
