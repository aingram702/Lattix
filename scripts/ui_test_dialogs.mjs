// Lattix dialog tests — the askModal replacements for window.confirm and
// window.prompt, including a real encrypted backup/restore round-trip.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_dialogs.mjs
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


const askSel = '.modal[id^="ask-"]';
const askVisible = (p) => p.locator(`${askSel}:not([hidden])`).count().then((n) => n > 0);

const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix dialog tests");
  console.log("===================");

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const A = await ctx.newPage();
  const errors = [];
  A.on("pageerror", (e) => errors.push(e.message));

  // Native dialogs must never appear. If one does, this handler fires and the
  // assertion below catches it.
  let nativeDialogs = 0;
  A.on("dialog", async (d) => { nativeDialogs++; await d.dismiss(); });

  const me = u("dlg"), peer = u("peer");
  await signUp(A, me);

  const B = await (await browser.newContext()).newPage();
  await signUp(B, peer);

  // Seed one conversation so there is something to back up.
  await A.click("#new-chat-btn");
  await A.fill("#search-input", peer);
  await A.waitForSelector(".search-item");
  await A.click(".search-item");
  await A.fill("#msg-input", "a message worth backing up");
  await A.click("#send-btn");
  await A.waitForSelector(".bubble.mine");
  await A.waitForTimeout(500);

  // ---------------- backup: validation, then a real file ----------------
  await A.click("#settings-btn");
  await A.waitForTimeout(300);
  await A.click("#backup-btn");
  await A.waitForTimeout(400);
  ok("backup opens an in-app dialog", await askVisible(A));
  ok("no native dialog was used", nativeDialogs === 0);

  const pwFields = await A.locator(`${askSel} input[type=password]`).count();
  ok("backup dialog asks for the password twice", pwFields === 2);

  // axe the generated dialog.
  await A.evaluate(AXE_SRC);
  const viol = await A.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('.modal[id^="ask-"]'),
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.filter((v) => v.impact === "critical" || v.impact === "serious")
      .map((v) => v.id + ":" + v.nodes.map((n) => n.target.join(" ")).join(","));
  });
  ok("axe: askModal dialog has no serious/critical violations", viol.length === 0, viol.join(" | "));

  // Too short -> refused, dialog stays open.
  await A.fill(`${askSel} input#${await A.getAttribute(`${askSel} input[type=password]`, "id")}`, "short");
  await A.locator(`${askSel} input[type=password]`).nth(1).fill("short");
  await A.locator(`${askSel} button[type=submit]`).click();
  await A.waitForTimeout(300);
  ok("a too-short backup password is refused", await askVisible(A));
  ok("the reason is shown in the dialog",
     /at least 8/i.test((await A.locator(`${askSel} .err`).textContent()) || ""));

  // Mismatch -> refused.
  await A.locator(`${askSel} input[type=password]`).nth(0).fill("correct-horse-battery");
  await A.locator(`${askSel} input[type=password]`).nth(1).fill("different-passphrase");
  await A.locator(`${askSel} button[type=submit]`).click();
  await A.waitForTimeout(300);
  ok("a mismatched confirmation is refused", await askVisible(A));
  ok("the mismatch is explained",
     /match/i.test((await A.locator(`${askSel} .err`).textContent()) || ""));

  // Matching -> the backup file is produced.
  await A.locator(`${askSel} input[type=password]`).nth(1).fill("correct-horse-battery");
  const dl = A.waitForEvent("download", { timeout: 20000 });
  await A.locator(`${askSel} button[type=submit]`).click();
  const download = await dl;
  const path = await download.path();
  const sealed = JSON.parse(readFileSync(path, "utf8"));
  ok(`backup downloads (${download.suggestedFilename()})`, !!path);
  ok("dialog closes once accepted", !(await askVisible(A)));
  ok("backup file is sealed, not plaintext",
     !JSON.stringify(sealed).includes("a message worth backing up"));
  ok("backup carries KDF parameters", !!(sealed.salt || sealed.kdf || sealed.iterations || sealed.n));

  // ---------------- restore: wrong password is reported ----------------
  await A.locator("#restore-file").setInputFiles(path);
  await A.waitForTimeout(400);
  ok("restore asks for the password in-app", await askVisible(A));
  await A.locator(`${askSel} input[type=password]`).fill("not-the-password");
  await A.locator(`${askSel} button[type=submit]`).click();
  await A.waitForTimeout(1500);
  const toasts = (await A.locator(".toast").allTextContents()).join(" | ");
  ok("a wrong backup password surfaces an error, not a crash",
     /fail|could not|invalid|decrypt|password/i.test(toasts), toasts);
  ok("no uncaught error from a bad restore", errors.length === 0, errors.join(" | "));

  // ---------------- restore: correct password ----------------
  await A.locator("#restore-file").setInputFiles(path);
  await A.waitForTimeout(400);
  await A.locator(`${askSel} input[type=password]`).fill("correct-horse-battery");
  await A.locator(`${askSel} button[type=submit]`).click();
  await A.waitForTimeout(2000);
  const restoreToast = (await A.locator(".toast").allTextContents()).join(" | ");
  ok("a correct backup password restores", /restored/i.test(restoreToast), restoreToast);

  // ---------------- Escape and backdrop settle the promise ----------------
  await A.click("#backup-btn");
  await A.waitForTimeout(350);
  await A.keyboard.press("Escape");
  await A.waitForTimeout(350);
  ok("Escape dismisses the dialog", !(await askVisible(A)));
  const leaked = await A.locator(askSel).count();
  ok(`a dismissed dialog is removed from the DOM (${leaked} left)`, leaked === 0);

  await A.click("#backup-btn");
  await A.waitForTimeout(350);
  await A.mouse.click(10, 10);
  await A.waitForTimeout(350);
  ok("a backdrop click dismisses the dialog", !(await askVisible(A)));
  ok("backdrop dismissal also cleans up", (await A.locator(askSel).count()) === 0);

  // Repeated open/dismiss must not accumulate nodes or stall.
  for (let i = 0; i < 3; i++) {
    await A.click("#backup-btn");
    await A.waitForTimeout(200);
    await A.keyboard.press("Escape");
    await A.waitForTimeout(200);
  }
  ok("repeated open/dismiss leaves nothing behind", (await A.locator(askSel).count()) === 0);

  // ---------------- delete: type-to-confirm guard ----------------
  await A.click("#delete-data-btn");
  await A.waitForTimeout(400);
  ok("delete-all opens an in-app dialog", await askVisible(A));
  const guard = A.locator(`${askSel} input[type=text]`);
  ok("delete-all demands a typed confirmation", (await guard.count()) === 1);

  await guard.fill("wrong-name");
  await A.locator(`${askSel} button[type=submit]`).click();
  await A.waitForTimeout(400);
  ok("a wrong confirmation string does not delete", await askVisible(A));
  ok("still logged in after a refused delete", await A.isVisible("#app-screen"));
  ok("the guard explains what to type",
     /type/i.test((await A.locator(`${askSel} .err`).textContent()) || ""));

  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);

  // ---------------- leave group ----------------
  await A.click("#settings-close").catch(() => {});
  await A.waitForTimeout(200);
  await A.click("#new-group-btn");
  await A.fill("#group-name", "Dialog Test Group");
  await A.click("#group-create-btn");
  await A.waitForSelector("#conversation:not([hidden])");
  await A.waitForTimeout(800);
  await A.click("#menu-btn");
  await A.waitForTimeout(250);
  await A.locator("#chat-menu button", { hasText: "Group info" }).click();
  await A.waitForTimeout(500);
  await A.click("#gi-leave");
  await A.waitForTimeout(400);
  ok("leave-group asks in-app, not with confirm()", await askVisible(A));
  await A.locator(`${askSel} button`, { hasText: "Cancel" }).click();
  await A.waitForTimeout(400);
  ok("cancelling leave-group keeps the group",
     await A.evaluate(() => !!document.querySelector(".contact")));

  ok("no native dialog was used anywhere", nativeDialogs === 0);
  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
