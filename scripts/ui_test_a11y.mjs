// Lattix accessibility regression test — an axe-core audit of every screen and
// dialog, plus a keyboard-only walkthrough (focus trap, Escape, focus return).
//
//   npm i -D playwright axe-core && npx playwright install chromium
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_a11y.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { signUp as _signUp, dismissBackupPrompt } from "./lib/harness.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);

// WCAG 2.1 A/AA only — that's the bar the plan set.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function audit(page, label) {
  await page.evaluate(AXE_SRC);
  const res = await page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
  }, AXE_TAGS);
  const serious = res.filter((v) => v.impact === "critical" || v.impact === "serious");
  ok(`axe: ${label} — no serious/critical violations`,
     serious.length === 0,
     serious.map((v) => `${v.id}[${v.impact}] ${v.nodes.join(",")}`).join(" | "));
  if (res.length && serious.length === 0) {
    console.log(`      (minor: ${res.map((v) => v.id).join(", ")})`);
  }
  return res;
}


const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix accessibility audit");
  console.log("==========================");

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const errors = [];
  A.on("pageerror", (e) => errors.push(e.message));

  const [me, peer] = [u("a11y"), u("peer")];

  // --- auth screen ---
  await A.goto(BASE);
  await A.waitForSelector("#create-form:not([hidden])");
  await audit(A, "auth screen");

  await signUp(A, me);
  await signUp(B, peer);

  // --- app shell, empty state ---
  await audit(A, "app shell (empty state)");

  // --- a live conversation ---
  await A.click("#new-chat-btn");
  await A.fill("#search-input", peer);
  await A.waitForSelector(".search-item");
  await A.click(".search-item");
  await A.fill("#msg-input", "Accessibility check — https://example.com");
  await A.click("#send-btn");
  await A.waitForSelector(".bubble.mine");
  await A.waitForTimeout(600);
  await audit(A, "open conversation");

  // ================= keyboard operability =================
  console.log("\nKeyboard operability");
  console.log("--------------------");

  // Every interactive control must be reachable by Tab.
  const unreachable = await A.evaluate(() => {
    const interactive = [...document.querySelectorAll(
      '#app-screen button:not([disabled]), #app-screen [role="button"], #app-screen input, #app-screen textarea')]
      .filter((n) => n.offsetParent !== null);
    return interactive
      .filter((n) => n.tabIndex < 0)
      .map((n) => n.id || n.className || n.tagName);
  });
  ok(`every visible control is tabbable (${unreachable.length} unreachable)`,
     unreachable.length === 0, unreachable.join(", "));

  // Contact rows: reachable and activatable by keyboard.
  const contactRow = await A.evaluate(() => {
    const c = document.querySelector(".contact");
    return { role: c.getAttribute("role"), tabindex: c.tabIndex, label: c.getAttribute("aria-label") };
  });
  ok("contact rows expose a button role and are tabbable",
     contactRow.role === "button" && contactRow.tabindex === 0 && !!contactRow.label);

  // Focus ring must be visible on a keyboard-focused control. Two things
  // matter here: :focus-visible styling only engages for *real* keyboard
  // focus (a programmatic .focus() does not repaint it in headless Chromium,
  // even though matches(":focus-visible") returns true), and a control with a
  // blanket `transition` would fade the ring in, so we assert it is instant.
  await A.evaluate(() => document.querySelector("#share-btn").focus());
  await A.keyboard.press("Tab");
  const ringNow = await A.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return { id: document.activeElement.id, width: cs.outlineWidth, style: cs.outlineStyle };
  });
  ok(`keyboard-focused control shows an outline immediately (#${ringNow.id}: ${ringNow.width} ${ringNow.style})`,
     parseFloat(ringNow.width) >= 1 && ringNow.style !== "none");

  // --- modal: focus moves in, traps, Escape closes, focus returns ---
  await A.click("#settings-btn");
  await A.waitForTimeout(300);
  const insideOnOpen = await A.evaluate(() =>
    document.querySelector("#settings-modal").contains(document.activeElement));
  ok("opening a dialog moves focus into it", insideOnOpen);

  const dlg = await A.evaluate(() => {
    const m = document.querySelector("#settings-modal");
    return { role: m.getAttribute("role"), modal: m.getAttribute("aria-modal"),
             labelledby: m.getAttribute("aria-labelledby") };
  });
  ok("dialog is marked role=dialog aria-modal with a label",
     dlg.role === "dialog" && dlg.modal === "true" && !!dlg.labelledby);

  // Tab many times; focus must never escape the dialog.
  let escaped = false;
  for (let i = 0; i < 40; i++) {
    await A.keyboard.press("Tab");
    if (!(await A.evaluate(() => document.querySelector("#settings-modal").contains(document.activeElement)))) {
      escaped = true; break;
    }
  }
  ok("Tab is trapped inside the open dialog", !escaped);

  // Shift+Tab too.
  let escapedBack = false;
  for (let i = 0; i < 40; i++) {
    await A.keyboard.press("Shift+Tab");
    if (!(await A.evaluate(() => document.querySelector("#settings-modal").contains(document.activeElement)))) {
      escapedBack = true; break;
    }
  }
  ok("Shift+Tab is trapped too", !escapedBack);

  await audit(A, "settings dialog");

  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);
  ok("Escape closes the dialog", await A.isHidden("#settings-modal"));
  ok("focus returns to the control that opened it",
     await A.evaluate(() => document.activeElement?.id === "settings-btn"));

  // --- stacked dialogs: Escape closes only the top one ---
  await A.click("#settings-btn");
  await A.waitForTimeout(250);
  await A.evaluate(() => document.querySelector("#share-btn").click());
  await A.waitForTimeout(300);
  const bothOpen = await A.evaluate(() => ({
    settings: !document.querySelector("#settings-modal").hidden,
    share: !document.querySelector("#share-modal").hidden,
  }));
  ok("dialogs can stack", bothOpen.settings && bothOpen.share);
  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);
  const afterOne = await A.evaluate(() => ({
    settings: !document.querySelector("#settings-modal").hidden,
    share: !document.querySelector("#share-modal").hidden,
  }));
  ok("Escape closes only the topmost dialog", afterOne.settings && !afterOne.share);
  await A.keyboard.press("Escape");
  await A.waitForTimeout(250);
  ok("a second Escape closes the one underneath", await A.isHidden("#settings-modal"));

  // --- backdrop click ---
  await A.click("#share-btn");
  await A.waitForTimeout(250);
  await A.mouse.click(12, 12);       // the scrim, well outside .modal-card
  await A.waitForTimeout(250);
  ok("clicking the backdrop closes the dialog", await A.isHidden("#share-modal"));

  // --- radiogroups report state ---
  await A.click("#settings-btn");
  await A.waitForTimeout(300);
  const radios = await A.evaluate(() => {
    const themes = [...document.querySelectorAll("#theme-choices .choice")];
    const swatches = [...document.querySelectorAll("#chat-swatches .swatch")];
    // NB: return arrays, not Sets — a Set does not survive serialization out
    // of page.evaluate and arrives as {}.
    return {
      themeTags: [...new Set(themes.map((t) => t.tagName))],
      swatchTags: [...new Set(swatches.map((s) => s.tagName))],
      themeChecked: themes.filter((t) => t.getAttribute("aria-checked") === "true").length,
      swatchChecked: swatches.filter((s) => s.getAttribute("aria-checked") === "true").length,
      groupRole: document.querySelector("#chat-swatches").getAttribute("role"),
    };
  });
  ok(`chat-colour swatches are real buttons, not divs (${radios.swatchTags.join("/")})`,
     radios.swatchTags.length === 1 && radios.swatchTags[0] === "BUTTON");
  ok(`theme choices are real buttons (${radios.themeTags.join("/")})`,
     radios.themeTags.length === 1 && radios.themeTags[0] === "BUTTON");
  ok("exactly one theme is reported checked", radios.themeChecked === 1);
  ok("exactly one chat colour is reported checked", radios.swatchChecked === 1);
  ok("swatches sit in a radiogroup", radios.groupRole === "radiogroup");

  // Activate a swatch with the keyboard alone.
  await A.evaluate(() => document.querySelector('#chat-swatches .swatch[data-c="green"]').focus());
  await A.keyboard.press("Enter");
  await A.waitForTimeout(250);
  ok("a swatch can be activated by keyboard",
     await A.evaluate(() => document.documentElement.getAttribute("data-chat") === "green"));
  await A.keyboard.press("Escape");
  await A.waitForTimeout(250);

  // --- kebab menu reports expanded state ---
  await A.click("#menu-btn");
  await A.waitForTimeout(250);
  ok("menu button reports aria-expanded=true when open",
     await A.evaluate(() => document.querySelector("#menu-btn").getAttribute("aria-expanded") === "true"));
  await A.keyboard.press("Escape");
  await A.waitForTimeout(250);
  ok("Escape closes the menu and resets aria-expanded",
     await A.evaluate(() => document.querySelector("#chat-menu").hidden &&
       document.querySelector("#menu-btn").getAttribute("aria-expanded") === "false"));

  // --- shortcuts ---
  await A.keyboard.press("Control+k");
  await A.waitForTimeout(350);
  ok("Ctrl+K opens the new-conversation dialog", await A.isVisible("#search-modal"));
  await A.keyboard.press("Escape");
  await A.waitForTimeout(250);

  await A.evaluate(() => document.activeElement.blur());
  await A.keyboard.press("/");
  await A.waitForTimeout(250);
  ok("/ focuses the message box",
     await A.evaluate(() => document.activeElement?.id === "msg-input"));
  ok("/ did not leak a literal slash into the box",
     (await A.inputValue("#msg-input")) === "");

  // Shortcuts must be inert while a dialog is open.
  await A.click("#settings-btn");
  await A.waitForTimeout(250);
  await A.keyboard.press("Control+k");
  await A.waitForTimeout(300);
  ok("shortcuts are inert while a dialog is open", await A.isHidden("#search-modal"));
  await A.keyboard.press("Escape");

  // --- live regions ---
  const live = await A.evaluate(() => ({
    toasts: document.querySelector("#toasts")?.getAttribute("aria-live"),
    messages: document.querySelector("#messages")?.getAttribute("aria-live"),
    messagesRole: document.querySelector("#messages")?.getAttribute("role"),
    conn: document.querySelector("#conn-status")?.getAttribute("aria-live"),
  }));
  ok("toasts announce politely", live.toasts === "polite");
  ok("message log is a polite live region", live.messages === "polite" && live.messagesRole === "log");
  ok("connection status announces politely", live.conn === "polite");

  // --- reduced motion honoured ---
  const reduced = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const R = await reduced.newPage();
  await R.goto(BASE);
  await R.waitForSelector(".primary");
  const dur = await R.evaluate(() => getComputedStyle(document.querySelector(".primary")).transitionDuration);
  ok(`transitions collapse under prefers-reduced-motion (${dur})`, parseFloat(dur) < 0.01);
  await reduced.close();

  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
