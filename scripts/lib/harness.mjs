// Shared helpers for the browser test suites.
//
// Account creation is the one flow every suite depends on, and it grew a
// confirm-password field, an acknowledgement checkbox and a post-signup
// backup prompt. Keeping it here stops six copies drifting apart.

export const TEST_PASSWORD = "correct-horse-battery";

/** Unique-ish username for a test run. */
export const uniq = (prefix) => prefix + Math.floor(Math.random() * 100000);

/**
 * Create an account and land on the app screen.
 * Dismisses the "back up your vault" prompt that follows signup.
 */
export async function signUp(page, username, base, password = TEST_PASSWORD) {
  await page.goto(base);
  await page.waitForSelector("#create-form:not([hidden])", { timeout: 20000 });
  await page.fill("#create-username", username);
  await page.fill("#create-password", password);
  await page.fill("#create-password2", password);
  await page.check("#create-ack");
  await page.click("#create-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
  await dismissBackupPrompt(page);
}

/**
 * The vault-backup prompt shown once after signup. Choosing "Later" leaves the
 * app in its normal state; suites that care about it assert on it themselves.
 */
export async function dismissBackupPrompt(page) {
  const later = page.locator('.modal[id^="ask-"]:not([hidden]) button', { hasText: "Later" });
  try {
    await later.waitFor({ state: "visible", timeout: 8000 });
    await later.click();
    await page.waitForTimeout(250);
  } catch {
    /* prompt not shown (e.g. unlock rather than signup) — nothing to do */
  }
}

/** Unlock an existing vault after a reload. */
export async function unlock(page, password = TEST_PASSWORD) {
  await page.waitForSelector("#unlock-form:not([hidden])", { timeout: 20000 });
  await page.fill("#unlock-password", password);
  await page.click("#unlock-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
}

/** Open a DM with `who` from the new-chat search. */
export async function openChat(page, who) {
  await page.click("#new-chat-btn");
  await page.fill("#search-input", who);
  await page.waitForSelector(".search-item", { timeout: 15000 });
  await page.click(".search-item");
  await page.waitForSelector("#conversation:not([hidden])");
}
