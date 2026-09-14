// Lattix theme tests — the "system" preference, the anti-flash bootstrap,
// persistence, and light-mode contrast.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_theme.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { signUp as _signUp } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);
const signUp = (page, username) => _signUp(page, username, BASE);

const themeOf = (p) => p.evaluate(() => ({
  applied: document.documentElement.getAttribute("data-theme"),
  stored: localStorage.getItem("lattix.theme"),
  colorScheme: document.documentElement.style.colorScheme,
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix theme tests");
  console.log("==================");

  // ---------------- system follows the OS ----------------
  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    const p = await ctx.newPage();
    await p.goto(BASE);
    await p.waitForSelector("#create-form:not([hidden])");
    await p.evaluate(() => localStorage.setItem("lattix.theme", "system"));
    await p.reload();
    await p.waitForSelector("#create-form:not([hidden])");
    const t = await themeOf(p);
    ok(`"system" resolves to ${scheme} when the OS prefers ${scheme} (got ${t.applied})`,
       t.applied === scheme);
    ok(`color-scheme is set to ${scheme}`, t.colorScheme === scheme);
    ok(`the preference stays "system", not the resolved palette (${t.stored})`,
       t.stored === "system");
    await ctx.close();
  }

  // Live OS change while on "system".
  {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const p = await ctx.newPage();
    await p.goto(BASE);
    await p.waitForSelector("#create-form:not([hidden])");
    await p.evaluate(() => localStorage.setItem("lattix.theme", "system"));
    await p.reload();
    await p.waitForSelector("#create-form:not([hidden])");
    await p.emulateMedia({ colorScheme: "light" });
    const followed = await p.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "light",
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    ok("a live OS switch is followed without a reload", followed);

    // An explicit choice must stop following the OS.
    await p.evaluate(() => localStorage.setItem("lattix.theme", "kali"));
    await p.reload();
    await p.waitForSelector("#create-form:not([hidden])");
    await p.emulateMedia({ colorScheme: "dark" });
    await p.waitForTimeout(500);
    ok("an explicit theme ignores the OS",
       (await themeOf(p)).applied === "kali");
    await ctx.close();
  }

  // ---------------- no flash before first paint ----------------
  {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const p = await ctx.newPage();
    await p.goto(BASE);
    await p.waitForSelector("#create-form:not([hidden])");
    await p.evaluate(() => localStorage.setItem("lattix.theme", "light"));

    // Record data-theme from the very first moment scripts can observe it.
    await p.addInitScript(() => {
      window.__themeAtStart = null;
      document.addEventListener("readystatechange", () => {
        if (window.__themeAtStart === null) {
          window.__themeAtStart = document.documentElement.getAttribute("data-theme");
        }
      }, { once: true });
    });
    await p.reload();
    await p.waitForSelector("#create-form:not([hidden])");
    const atStart = await p.evaluate(() => window.__themeAtStart);
    ok(`the stored theme is applied before the document is ready (${atStart})`,
       atStart === "light");

    // The bootstrap must be an external file — MV3 forbids inline script.
    const html = await p.content();
    ok("the theme bootstrap is an external script, not inline",
       /<script[^>]+src="js\/preload\.js"/.test(html));
    const inlineScripts = await p.evaluate(() =>
      [...document.querySelectorAll("script")].filter((s) => !s.src && s.textContent.trim()).length);
    ok(`no inline <script> anywhere (MV3 CSP safe) (${inlineScripts} found)`, inlineScripts === 0);
    await ctx.close();
  }

  // ---------------- the Settings control ----------------
  {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const p = await ctx.newPage();
    await signUp(p, u("theme"));
    await p.click("#settings-btn");
    await p.waitForTimeout(400);

    const choices = await p.evaluate(() =>
      [...document.querySelectorAll("#theme-choices .choice")].map((c) => c.dataset.theme));
    ok(`Settings offers System plus the four palettes (${choices.join(", ")})`,
       choices.length === 5 && choices[0] === "system");

    await p.click('#theme-choices .choice[data-theme="system"]');
    await p.waitForTimeout(400);
    const t = await themeOf(p);
    ok("choosing System applies the OS palette", t.applied === "light" && t.stored === "system");
    ok("System is reported as the checked radio",
       await p.evaluate(() =>
         document.querySelector('.choice[data-theme="system"]').getAttribute("aria-checked") === "true"));

    // theme-color keeps step with the applied palette.
    const metaLight = await p.evaluate(() =>
      document.querySelector('meta[name="theme-color"]:not([media])')?.content);
    await p.click('#theme-choices .choice[data-theme="kali"]');
    await p.waitForTimeout(300);
    const metaKali = await p.evaluate(() =>
      document.querySelector('meta[name="theme-color"]:not([media])')?.content);
    ok(`theme-color tracks the palette (${metaLight} -> ${metaKali})`,
       metaLight === "#eef1f7" && metaKali === "#0a0e14");

    await p.click("#settings-close");
    await ctx.close();
  }

  // ---------------- light-mode contrast ----------------
  {
    const ctx = await browser.newContext({ colorScheme: "light", viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    const B = await (await browser.newContext()).newPage();
    const me = u("lightme"), peer = u("lightpeer");
    await signUp(p, me);
    await signUp(B, peer);
    await p.evaluate(() => localStorage.setItem("lattix.theme", "light"));
    await p.reload();
    await p.waitForSelector("#unlock-form:not([hidden])");
    await p.fill("#unlock-password", "correct-horse-battery");
    await p.click("#unlock-form button[type=submit]");
    await p.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });

    await p.click("#new-chat-btn");
    await p.fill("#search-input", peer);
    await p.waitForSelector(".search-item");
    await p.click(".search-item");
    await p.fill("#msg-input", "checking contrast in light mode");
    await p.click("#send-btn");
    await p.waitForSelector(".bubble.mine");
    await p.waitForTimeout(600);

    ok("the light theme is actually applied",
       (await themeOf(p)).applied === "light");

    await p.evaluate(AXE_SRC);
    const viol = await p.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return r.violations
        .filter((v) => v.impact === "critical" || v.impact === "serious")
        .map((v) => `${v.id}[${v.impact}] ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(",")}`);
    });
    ok("axe: light mode has no serious/critical violations", viol.length === 0, viol.join(" | "));

    // The two ratios that were under AA before this phase.
    const measured = await p.evaluate(() => {
      const cs = (sel, prop) => {
        const n = document.querySelector(sel);
        return n ? getComputedStyle(n)[prop] : null;
      };
      return {
        mineMetaOpacity: cs(".bubble.mine .msg-meta", "opacity"),
        muted: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(),
      };
    });
    ok(`the outgoing timestamp is at full opacity (${measured.mineMetaOpacity})`,
       parseFloat(measured.mineMetaOpacity) === 1);
    ok(`--muted was darkened for light mode (${measured.muted})`,
       measured.muted.toLowerCase() === "#616a7a");

    await ctx.close();
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
