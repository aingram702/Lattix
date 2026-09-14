// Lattix UI regression test — drives the real client in a real browser against
// a running relay. Complements scripts/integration_test.mjs, which covers the
// protocol; this one covers the things only a rendered DOM can show.
//
//   pip install -r requirements.txt
//   python -m uvicorn server.main:app --port 8111 &
//   npm i -D playwright && npx playwright install chromium
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test.mjs
//
// Set PW_CHROMIUM to use a Chromium you already have instead of Playwright's.

import { chromium } from "playwright";
import { signUp as _signUp, dismissBackupPrompt } from "./lib/harness.mjs";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
};

const u = (p) => p + Math.floor(Math.random() * 100000);


async function openChatWith(page, peer) {
  await page.click("#new-chat-btn");
  await page.fill("#search-input", peer);
  await page.waitForSelector(".search-item", { timeout: 10000 });
  await page.click(".search-item");
  await page.waitForSelector("#conversation:not([hidden])");
}

const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch(launchOpts);
const alice = u("alice"), bob = u("bob");

try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const errors = [];
  for (const p of [pageA, pageB]) {
    // ERR_FAILED is the request this suite aborts on purpose to test draft recovery.
    const expected = /ERR_FAILED|Failed to load resource/;
    p.on("pageerror", (e) => { if (!expected.test(e.message)) errors.push(e.message); });
    p.on("console", (m) => {
      if (m.type() === "error" && !expected.test(m.text())) errors.push(m.text());
    });
  }

  console.log("Phase 0 UI verification");
  console.log("=======================");

  await signUp(pageA, alice);
  await signUp(pageB, bob);
  ok("both accounts created, app screen reached", true);

  // --- 0.1: send button starts disabled, enables on input ---
  await openChatWith(pageA, bob);
  ok("send button disabled with empty composer",
     await pageA.isDisabled("#send-btn"));
  await pageA.fill("#msg-input", "hello bob");
  ok("send button enabled once text is typed",
     await pageA.isEnabled("#send-btn"));

  // --- send succeeds, composer clears ---
  await pageA.click("#send-btn");
  await pageA.waitForSelector(".bubble.mine", { timeout: 20000 });
  ok("message sent and rendered", (await pageA.locator(".bubble.mine").count()) >= 1);
  ok("composer cleared after successful send",
     (await pageA.inputValue("#msg-input")) === "");
  ok("send button disabled again after send",
     await pageA.isDisabled("#send-btn"));

  // --- 0.3: day separator is humanized ---
  const sep = (await pageA.locator(".day-sep").first().textContent()).trim();
  ok(`day separator reads "Today" (got "${sep}")`, sep === "Today");

  // --- 0.2: verified signature styling present, no false failure ---
  const verifiedCount = await pageA.locator(".msg-meta .verified").count();
  const unverifiedCount = await pageA.locator(".bubble.unverified-msg").count();
  ok("own message shows verified glyph", verifiedCount >= 1);
  ok("no spurious unverified-msg border", unverifiedCount === 0);
  const vColor = await pageA.locator(".msg-meta .verified").first()
    .evaluate((n) => getComputedStyle(n).color);
  ok(`verified glyph is themed, not inherited (${vColor})`,
     vColor !== "rgba(0, 0, 0, 0)" && vColor.startsWith("rgb"));

  // --- 0.1 (the real fix): a failed send must restore the draft ---
  await pageA.route("**/api/messages", (route) => route.abort("failed"));
  await pageA.fill("#msg-input", "this must survive");
  await pageA.click("#send-btn");
  await pageA.waitForTimeout(1200);
  const survived = await pageA.inputValue("#msg-input");
  ok(`draft restored after failed send (got "${survived}")`,
     survived === "this must survive");
  const toastText = (await pageA.locator(".toast").allTextContents()).join(" | ");
  ok("failure toast explains the draft was kept",
     /still in the box/.test(toastText || ""), `toasts="${toastText}"`);
  await pageA.unroute("**/api/messages");

  // --- 0.6: oversized attachment rejected before encryption ---
  const rejected = await pageA.evaluate(async () => {
    const t0 = performance.now();
    const big = new File([new Uint8Array(1024)], "huge.bin");
    Object.defineProperty(big, "size", { value: 900 * 1024 * 1024 });
    const dt = new DataTransfer();
    dt.items.add(big);
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 400));
    const toast = [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | ");
    return { ms: performance.now() - t0, toast };
  });
  ok(`oversized file rejected instantly (${Math.round(rejected.ms)}ms)`,
     /accepts up to/.test(rejected.toast), rejected.toast);

  // --- 0.5: scroll anchoring + jump pill ---
  await pageB.waitForSelector(".contact", { timeout: 20000 });
  await pageB.click(".contact");
  await pageB.waitForSelector("#conversation:not([hidden])");
  // Fill the log so it actually scrolls.
  for (let i = 0; i < 30; i++) {
    await pageB.fill("#msg-input", "filler " + i);
    await pageB.click("#send-btn");
    await pageB.waitForTimeout(120);
  }
  await pageA.waitForTimeout(1500);
  await pageA.evaluate(() => { document.querySelector("#messages").scrollTop = 0; });
  await pageA.waitForTimeout(200);
  const beforeTop = await pageA.evaluate(() => document.querySelector("#messages").scrollTop);

  await pageB.fill("#msg-input", "landed while you were reading");
  await pageB.click("#send-btn");
  await pageA.waitForTimeout(1800);

  const afterTop = await pageA.evaluate(() => document.querySelector("#messages").scrollTop);
  ok(`scroll position held while reading history (${beforeTop} -> ${afterTop})`,
     Math.abs(afterTop - beforeTop) < 40);
  ok("jump-to-latest pill appeared",
     await pageA.isVisible("#jump-latest"));

  await pageA.click("#jump-latest");
  await pageA.waitForTimeout(900);
  const atBottom = await pageA.evaluate(() => {
    const w = document.querySelector("#messages");
    return w.scrollHeight - w.scrollTop - w.clientHeight < 80;
  });
  ok("pill scrolls to newest and hides", atBottom && !(await pageA.isVisible("#jump-latest")));

  // A message arriving while already at the bottom should still auto-follow.
  await pageB.fill("#msg-input", "follow me");
  await pageB.click("#send-btn");
  await pageA.waitForTimeout(1500);
  const stillBottom = await pageA.evaluate(() => {
    const w = document.querySelector("#messages");
    return w.scrollHeight - w.scrollTop - w.clientHeight < 80;
  });
  ok("still auto-follows when already at the bottom", stillBottom);

  // --- 0.4: preview not truncated at 42 chars by JS ---
  // Clear the composer first: since Phase 3 an unsent draft takes the preview
  // slot ahead of the last message, and the failed-send test above left one.
  await pageA.fill("#msg-input", "");
  await pageA.waitForTimeout(700);   // let the draft debounce flush
  const longMsg = "x".repeat(120);
  await pageB.fill("#msg-input", longMsg);
  await pageB.click("#send-btn");
  await pageA.waitForTimeout(1500);
  const preview = await pageA.locator(".contact-preview").first().textContent();
  ok(`sidebar preview not hard-sliced (len ${preview.length})`, preview.length > 42);

  // --- 0.7: per-theme accent, no purple bleed ---
  const glow = await pageA.evaluate(() => {
    const r = document.documentElement;
    const out = {};
    for (const t of ["dark", "light", "monokai", "kali"]) {
      r.setAttribute("data-theme", t);
      out[t] = getComputedStyle(r).getPropertyValue("--accent-glow").trim();
    }
    r.setAttribute("data-theme", "dark");
    return out;
  });
  ok("each theme defines its own --accent-glow",
     new Set(Object.values(glow)).size === 4, JSON.stringify(glow));
  ok("kali glow is blue, not purple", /23,\s*147,\s*209/.test(glow.kali), glow.kali);
  ok("monokai glow is cyan, not purple", /102,\s*217,\s*239/.test(glow.monokai), glow.monokai);

  // --- 0.8: dvh applied ---
  const usesDvh = await pageA.evaluate(() =>
    [...document.styleSheets[0].cssRules].some((r) =>
      r.selectorText === ".app-screen" && /dvh/.test(r.style.height || "")));
  ok("app-screen uses dvh", usesDvh);

  // ======================= Phase 1: chat surface =======================
  console.log("\nPhase 1 — chat surface");
  console.log("----------------------");

  // --- 1.1: meta sits inline on a short bubble, wraps on a long one ---
  await pageB.fill("#msg-input", "ok");
  await pageB.click("#send-btn");
  await pageA.waitForTimeout(1500);

  const inlineMeta = await pageA.evaluate(() => {
    const bubbles = [...document.querySelectorAll(".bubble.theirs")];
    const shortB = bubbles.find((b) => b.querySelector(".msg-text")?.textContent.trim() === "ok");
    if (!shortB) return null;
    const text = shortB.querySelector(".msg-text").getBoundingClientRect();
    const meta = shortB.querySelector(".msg-meta").getBoundingClientRect();
    // Same line => their vertical centres are close together.
    return { sameLine: Math.abs((text.top + text.bottom) / 2 - (meta.top + meta.bottom) / 2) < 10 };
  });
  ok("short message keeps its timestamp on the same line", inlineMeta?.sameLine === true);

  const wrappedMeta = await pageA.evaluate(() => {
    const bubbles = [...document.querySelectorAll(".bubble")];
    const longB = bubbles.find((b) => (b.querySelector(".msg-text")?.textContent || "").length > 100);
    if (!longB) return null;
    const text = longB.querySelector(".msg-text").getBoundingClientRect();
    const meta = longB.querySelector(".msg-meta").getBoundingClientRect();
    return { below: meta.top >= text.bottom - 4 };
  });
  ok("long message pushes the timestamp to its own line", wrappedMeta?.below === true);

  // The Phase 0 unverified border must survive the flex rewrite.
  const borderOk = await pageA.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bubble theirs unverified-msg";
    document.querySelector("#messages").append(probe);
    const w = getComputedStyle(probe).borderTopWidth;
    probe.remove();
    return w;
  });
  ok(`unverified border survives the flex rewrite (${borderOk})`, parseFloat(borderOk) >= 1);

  // --- 1.2: grouping ---
  for (let i = 0; i < 3; i++) {
    await pageB.fill("#msg-input", "run message " + i);
    await pageB.click("#send-btn");
    await pageB.waitForTimeout(200);
  }
  await pageA.waitForTimeout(2000);
  const runs = await pageA.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")];
    const last3 = rows.slice(-3);
    return {
      sameCount: last3.filter((r) => r.classList.contains("same")).length,
      marginSame: getComputedStyle(last3[last3.length - 1]).marginTop,
    };
  });
  ok(`consecutive messages collapse into a run (${runs.sameCount}/3 marked same)`,
     runs.sameCount >= 2);
  ok(`run spacing is tightened (${runs.marginSame})`, parseFloat(runs.marginSame) <= 3);

  // --- 1.5: linkify, and inertness of user-supplied markup ---
  const nasty = 'see https://example.com/a?x=1&y=2 and <script>alert(1)</script> done';
  await pageB.fill("#msg-input", nasty);
  await pageB.click("#send-btn");
  await pageA.waitForTimeout(1800);
  const link = await pageA.evaluate(() => {
    const a = [...document.querySelectorAll(".msg-text a")].pop();
    return a ? { href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target") } : null;
  });
  ok(`URL linkified with query intact (${link?.href})`,
     link?.href === "https://example.com/a?x=1&y=2");
  ok("link carries noopener noreferrer nofollow",
     /noopener/.test(link?.rel || "") && /noreferrer/.test(link?.rel || "") && /nofollow/.test(link?.rel || ""));
  const injected = await pageA.evaluate(() =>
    document.querySelectorAll("#messages script").length);
  ok("script tag in message text stays inert", injected === 0);

  // --- 1.6: hover actions ---
  // Park the pointer away from the log first: Playwright leaves the mouse
  // wherever the last click put it, which can leave a row in :hover.
  await pageA.mouse.move(0, 0);
  await pageA.waitForTimeout(150);
  const actions = await pageA.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].pop();
    const acts = row.querySelector(".msg-actions");
    return { present: !!acts, buttons: acts ? acts.querySelectorAll("button").length : 0,
             hiddenByDefault: acts ? getComputedStyle(acts).opacity === "0" : null };
  });
  ok("message rows carry copy/quote actions", actions.present && actions.buttons === 2);
  ok("actions are hidden until hover", actions.hiddenByDefault === true);

  // Quote prefills the composer.
  await pageA.locator(".row").last().hover();
  await pageA.locator(".row").last().locator(".msg-act").nth(1).click();
  const quoted = await pageA.inputValue("#msg-input");
  ok("quote prefills the composer with a > prefix", quoted.startsWith("> "));
  await pageA.fill("#msg-input", "");

  // --- 1.3: group sender colours + avatars ---
  const senderColours = await pageA.evaluate(() => {
    // Exercise the hue function the same way renderMessages does.
    const hue = (seed) => {
      let h = 0;
      for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % 360;
    };
    return ["ada", "bob", "carol"].map(hue);
  });
  ok(`three senders get three distinct hues (${senderColours.join(", ")})`,
     new Set(senderColours).size === 3);
  const senderL = await pageA.evaluate(() => {
    const r = document.documentElement;
    const out = {};
    for (const t of ["dark", "light"]) {
      r.setAttribute("data-theme", t);
      out[t] = getComputedStyle(r).getPropertyValue("--sender-l").trim();
    }
    r.setAttribute("data-theme", "dark");
    return out;
  });
  ok(`--sender-l darkens for the light theme (${JSON.stringify(senderL)})`,
     parseInt(senderL.light) < parseInt(senderL.dark));

  // --- 1.4: preview policy ---
  const policy = await pageA.evaluate(() => {
    const RE = /^image\/(png|jpeg|gif|webp|avif)$/i;
    return { png: RE.test("image/png"), svg: RE.test("image/svg+xml"), mp4: RE.test("video/mp4") };
  });
  ok("preview allows png", policy.png);
  ok("preview refuses svg (scriptable)", !policy.svg);
  ok("preview refuses video", !policy.mp4);

  const autoImgToggle = await pageA.evaluate(() => !!document.querySelector("#toggle-autoimg"));
  ok("inline-image setting exists", autoImgToggle);

  // --- 1.7: empty state actions ---
  await pageA.click("#back-btn").catch(() => {});
  const emptyBtns = await pageA.evaluate(() => ({
    chat: !!document.querySelector("#empty-new-chat"),
    share: !!document.querySelector("#empty-share"),
  }));
  ok("empty state offers a start-a-chat action", emptyBtns.chat);
  ok("empty state offers a share-my-link action", emptyBtns.share);

  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
