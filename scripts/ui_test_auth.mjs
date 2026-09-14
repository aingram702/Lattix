// Lattix account-creation tests — the guards around a password that cannot be
// recovered, and the vault-overwrite warning.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_auth.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { signUp as _signUp, unlock, TEST_PASSWORD } from "./lib/harness.mjs";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);

const signUp = (page, username) => _signUp(page, username, BASE);
const askSel = '.modal[id^="ask-"]';
const toasts = (p) => p.locator(".toast").allTextContents().then((t) => t.join(" | "));

async function freshAuthPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForSelector("#create-form:not([hidden])");
  return { ctx, p };
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix account-creation tests");
  console.log("=============================");

  // ---------------- the form itself ----------------
  {
    const { p } = await freshAuthPage(browser);
    ok("signup asks for the password twice",
       (await p.locator("#create-form input[type=password]").count()) === 2);
    ok("signup requires an explicit acknowledgement", await p.isVisible("#create-ack"));
    const ackText = await p.locator(".ack span").textContent();
    ok(`the acknowledgement says what is at stake ("${ackText.slice(0, 46)}…")`,
       /cannot be recovered/i.test(ackText));

    // Strength meter reacts to what is typed.
    const readings = [];
    for (const pw of ["short", "abcdefghijkl", "Abcdefghijkl1!xyz"]) {
      await p.fill("#create-password", pw);
      await p.waitForTimeout(150);
      readings.push(await p.evaluate(() => ({
        cls: document.querySelector("#pw-meter").className,
        hint: document.querySelector("#pw-hint").textContent,
      })));
    }
    ok(`the meter rates a weak password low ("${readings[0].hint.split("—")[0].trim()}")`,
       readings[0].cls.endsWith("s0"));
    ok(`the meter improves with length and variety (${readings.map((r) => r.cls.slice(-2)).join(" → ")})`,
       readings[2].cls > readings[0].cls);
    ok("the hint suggests a passphrase", /words/i.test(readings[2].hint));
  }

  // ---------------- validation happens before keygen ----------------
  {
    const { p } = await freshAuthPage(browser);
    const name = u("mismatch");

    // Count register calls: none should be made for a rejected form.
    let registerCalls = 0;
    await p.route("**/api/register", (r) => { registerCalls++; r.continue(); });

    await p.fill("#create-username", name);
    await p.fill("#create-password", TEST_PASSWORD);
    await p.fill("#create-password2", "something-else-entirely");
    await p.check("#create-ack");
    await p.click("#create-form button[type=submit]");
    await p.waitForTimeout(1200);

    ok("a mismatched confirmation is refused", /don't match/i.test(await toasts(p)));
    ok("still on the signup form after a mismatch", await p.isVisible("#create-form"));
    ok("no account was registered for a mismatched password", registerCalls === 0);
    ok("focus moves to the field to correct",
       await p.evaluate(() => document.activeElement?.id === "create-password2"));

    // Too short. minlength="8" means the browser refuses before our submit
    // handler runs, so check constraint validation, not the toast. (The JS
    // length check still guards programmatic submits — exercised below.)
    await p.fill("#create-password", "short");
    await p.fill("#create-password2", "short");
    await p.click("#create-form button[type=submit]");
    await p.waitForTimeout(900);
    const shortState = await p.evaluate(() => {
      const f = document.querySelector("#create-password");
      return { valid: f.checkValidity(), msg: f.validationMessage };
    });
    ok(`a too-short password is refused by the form ("${shortState.msg.slice(0, 40)}…")`,
       shortState.valid === false);
    ok("no account registered for a short password", registerCalls === 0);

    // The same check, reached programmatically past the browser's guard.
    const shortToast = await p.evaluate(async () => {
      document.querySelector("#create-form")
        .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      return [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | ");
    });
    ok("the length rule is also enforced in JS", /at least 8/i.test(shortToast), shortToast);

    // Acknowledgement withheld.
    await p.fill("#create-password", TEST_PASSWORD);
    await p.fill("#create-password2", TEST_PASSWORD);
    await p.evaluate(() => { document.querySelector("#create-ack").checked = false; });
    await p.evaluate(() => document.querySelector("#create-form")
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })));
    await p.waitForTimeout(900);
    ok("creation is refused without the acknowledgement",
       /confirm you understand/i.test(await toasts(p)));
    ok("no account registered without the acknowledgement", registerCalls === 0);
  }

  // ---------------- caps lock ----------------
  // Playwright/CDP cannot set the OS-level Caps Lock state — getModifierState
  // always reports false — so drive the handler with an event that claims the
  // lock is on. This covers the wiring (listener attached, right element,
  // toggle both ways), not the browser's own lock detection.
  {
    const { p } = await freshAuthPage(browser);
    const states = await p.evaluate(async () => {
      const field = document.querySelector("#create-password");
      const warn = document.querySelector("#caps-warn");
      const fire = (caps) => {
        const e = new KeyboardEvent("keyup", { key: "a", bubbles: true });
        Object.defineProperty(e, "getModifierState", { value: (k) => k === "CapsLock" && caps });
        field.dispatchEvent(e);
      };
      fire(true);
      await new Promise((r) => setTimeout(r, 50));
      const on = !warn.hidden;
      fire(false);
      await new Promise((r) => setTimeout(r, 50));
      const off = warn.hidden;
      return { on, off };
    });
    ok("Caps Lock is called out while typing a password", states.on);
    ok("the Caps Lock warning clears again", states.off);
  }

  // ---------------- the happy path, and the backup nudge ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const name = u("happy");
    await p.goto(BASE);
    await p.waitForSelector("#create-form:not([hidden])");
    await p.fill("#create-username", name);
    await p.fill("#create-password", TEST_PASSWORD);
    await p.fill("#create-password2", TEST_PASSWORD);
    await p.check("#create-ack");

    // The submit button should show progress, not just sit there: keygen plus
    // a 250k-round PBKDF2 seal is a visible pause.
    // Arm the observer first, then click — awaiting it before clicking would
    // just time out waiting for a state change that had not been triggered.
    const spinning = p.evaluate(() => new Promise((resolve) => {
      const btn = document.querySelector("#create-form button[type=submit]");
      if (btn.classList.contains("busy")) return resolve(true);
      const obs = new MutationObserver(() => {
        if (btn.classList.contains("busy")) { obs.disconnect(); resolve(true); }
      });
      obs.observe(btn, { attributes: true, attributeFilter: ["class"] });
      setTimeout(() => { obs.disconnect(); resolve(false); }, 20000);
    }));
    await p.click("#create-form button[type=submit]");
    const spun = await spinning;
    await p.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
    ok("the create button shows progress while keys are generated", spun === true);

    // The backup prompt should follow signup.
    const prompt = p.locator(`${askSel}:not([hidden])`);
    await prompt.waitFor({ state: "visible", timeout: 10000 });
    const promptText = await prompt.textContent();
    ok("signup is followed by a prompt to back up the vault",
       /back up your vault/i.test(promptText));
    ok("the prompt explains why it matters",
       /only way to restore/i.test(promptText));

    // Accepting it downloads the vault.
    const dl = p.waitForEvent("download", { timeout: 20000 });
    await prompt.locator("button", { hasText: "Export vault" }).click();
    const file = await dl;
    ok(`accepting the prompt exports the vault (${file.suggestedFilename()})`,
       /vault/i.test(file.suggestedFilename()));

    await ctx.close();
  }

  // "Later" must dismiss without exporting.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    let downloads = 0;
    p.on("download", () => downloads++);
    await signUp(p, u("later"));     // helper clicks "Later"
    await p.waitForTimeout(600);
    ok("declining the backup prompt closes it", (await p.locator(askSel).count()) === 0);
    ok("declining exports nothing", downloads === 0);
    await ctx.close();
  }

  // ---------------- overwrite guard ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const first = u("first");
    await signUp(p, first);

    // Reload: the device now holds a vault, so we land on unlock.
    await p.reload();
    await p.waitForSelector("#unlock-form:not([hidden])", { timeout: 20000 });
    const vaultBefore = await p.evaluate(() => localStorage.getItem("lattix.vault"));

    // Go to "New account" and try to create a second identity.
    await p.click('[data-goto="create"]');
    await p.waitForSelector("#create-form:not([hidden])");
    await p.fill("#create-username", u("second"));
    await p.fill("#create-password", TEST_PASSWORD);
    await p.fill("#create-password2", TEST_PASSWORD);
    await p.check("#create-ack");
    await p.click("#create-form button[type=submit]");
    await p.waitForTimeout(900);

    const warning = p.locator(`${askSel}:not([hidden])`);
    ok("creating over an existing vault warns first", await warning.count() > 0);
    const warnText = await warning.textContent();
    ok("the warning says the old keys would be lost",
       /keys are gone|overwrites/i.test(warnText), warnText.slice(0, 80));

    // Cancel: the original vault must be untouched.
    await warning.locator("button", { hasText: "Cancel" }).click();
    await p.waitForTimeout(600);
    const vaultAfter = await p.evaluate(() => localStorage.getItem("lattix.vault"));
    ok("cancelling leaves the existing vault intact", vaultAfter === vaultBefore);
    ok("cancelling does not create an account", await p.isVisible("#create-form"));

    // The original identity still unlocks.
    await p.reload();
    await unlock(p);
    ok("the original identity still unlocks after cancelling",
       await p.isVisible("#app-screen"));
    const who = await p.locator("#self-name").textContent();
    ok(`the unlocked identity is the original one (${who})`, who === first);

    await ctx.close();
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
