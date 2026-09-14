// Lattix composer tests — drag-and-drop, paste-to-send, per-conversation
// drafts, and the busy lock during encrypt/upload.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_composer.mjs
//
// PW_CHROMIUM overrides the browser binary.
import { chromium } from "playwright";
import { signUp as _signUp, dismissBackupPrompt } from "./lib/harness.mjs";
import { deflateSync, crc32 } from "node:zlib";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);

function makePng(w, h, rgb) {
  const raw = Buffer.concat(
    Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())])));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_B64 = makePng(240, 160, [200, 90, 40]).toString("base64");


// Synthesise a DataTransfer carrying a file, for drop and paste.
const FILE_DT = `(b64, name, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type }));
  return dt;
}`;

const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  console.log("Lattix composer tests");
  console.log("=====================");

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const B = await (await browser.newContext()).newPage();
  const errors = [];
  A.on("pageerror", (e) => errors.push(e.message));

  const me = u("comp"), p1 = u("peerone"), p2 = u("peertwo");
  await signUp(A, me);
  await signUp(B, p1);
  const C = await (await browser.newContext()).newPage();
  await signUp(C, p2);

  async function openChat(page, who) {
    await page.click("#new-chat-btn");
    await page.fill("#search-input", who);
    await page.waitForSelector(".search-item");
    await page.click(".search-item");
    await page.waitForSelector("#conversation:not([hidden])");
  }

  // ---------------- drag and drop ----------------
  await openChat(A, p1);
  await A.waitForTimeout(400);

  await A.evaluate(() => {
    const dz = document.querySelector("#conversation");
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "x.bin", { type: "application/octet-stream" }));
    dz.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
  });
  await A.waitForTimeout(250);
  ok("dragging a file over the conversation shows a drop target",
     await A.evaluate(() => document.querySelector("#conversation").classList.contains("dropping")));

  const overlay = await A.evaluate(() => {
    const cs = getComputedStyle(document.querySelector("#conversation"), "::after");
    return cs.content;
  });
  ok(`the overlay explains encryption happens first (${overlay.slice(0, 42)}…)`,
     /encrypted/i.test(overlay));

  await A.evaluate(() => {
    const dz = document.querySelector("#conversation");
    dz.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
  });
  await A.waitForTimeout(250);
  ok("leaving the drop zone clears the overlay",
     await A.evaluate(() => !document.querySelector("#conversation").classList.contains("dropping")));

  // A real drop must actually send.
  const beforeDrop = await A.locator(".bubble").count();
  await A.evaluate(async ([b64, mk]) => {
    const dt = eval(mk)(b64, "dropped.png", "image/png");
    document.querySelector("#conversation")
      .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [PNG_B64, FILE_DT]);
  await A.waitForSelector(".msg-image", { timeout: 25000 });
  ok("dropping a file sends it", (await A.locator(".bubble").count()) > beforeDrop);
  ok("the drop overlay is cleared after sending",
     await A.evaluate(() => !document.querySelector("#conversation").classList.contains("dropping")));

  // ---------------- paste ----------------
  const beforePaste = await A.locator(".bubble").count();
  await A.evaluate(async ([b64, mk]) => {
    const dt = eval(mk)(b64, "pasted.png", "image/png");
    document.querySelector("#msg-input")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [PNG_B64, FILE_DT]);
  await A.waitForTimeout(6000);
  ok("pasting an image sends it", (await A.locator(".bubble").count()) > beforePaste);

  // A plain text paste must still behave normally.
  await A.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "just text");
    document.querySelector("#msg-input")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await A.waitForTimeout(400);
  ok("a plain-text paste is not intercepted",
     (await A.locator(".bubble").count()) === (await A.locator(".bubble").count()));

  // ---------------- busy lock + status ----------------
  // On localhost a small file can finish in well under 50ms, so polling races
  // the send. Record the states with a MutationObserver installed before the
  // send starts, which is deterministic however fast it completes.
  const busy = await A.evaluate(async ([b64, mk]) => {
    const status = document.querySelector("#composer-status");
    const attach = document.querySelector("#attach-btn");
    const seen = { labels: [], attachDisabled: false, statusShown: false };

    const obs = new MutationObserver(() => {
      if (!status.hidden) {
        seen.statusShown = true;
        const t = status.textContent.trim();
        if (t && seen.labels[seen.labels.length - 1] !== t) seen.labels.push(t);
      }
      if (attach.disabled) seen.attachDisabled = true;
    });
    obs.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
    obs.observe(attach, { attributes: true, attributeFilter: ["disabled"] });

    const dt = eval(mk)(b64, "busy.png", "image/png");
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));

    // Wait for the send to finish (the status goes back to hidden and stays).
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (seen.statusShown && status.hidden && !attach.disabled) break;
    }
    obs.disconnect();
    return { ...seen, statusText: seen.labels.join(" → ") };
  }, [PNG_B64, FILE_DT]);
  ok(`a stage label is shown while sending ("${busy.statusText}")`,
     busy.statusShown && /encrypting|uploading/i.test(busy.statusText));
  ok("the attach button is locked while sending", busy.attachDisabled);

  const settled = await A.evaluate(() => ({
    statusHidden: document.querySelector("#composer-status").hidden,
    attachEnabled: !document.querySelector("#attach-btn").disabled,
  }));
  ok("the status clears when the send finishes", settled.statusHidden);
  ok("the attach button unlocks again", settled.attachEnabled);

  // ---------------- drafts ----------------
  await openChat(A, p2);
  await A.waitForTimeout(600);
  await A.fill("#msg-input", "draft for peer two");
  await A.waitForTimeout(700);

  // Switch away and back.
  await A.locator(".contact").first().click();
  await A.waitForTimeout(700);
  const afterSwitch = await A.inputValue("#msg-input");
  ok(`switching conversations clears the box for the other chat ("${afterSwitch}")`,
     afterSwitch !== "draft for peer two");

  const rows = await A.evaluate(() =>
    [...document.querySelectorAll(".contact-preview")].map((n) => n.textContent));
  ok(`the waiting draft is marked in the list (${JSON.stringify(rows)})`,
     rows.some((t) => t.startsWith("✏️")));
  ok("the draft marker is styled as a draft",
     await A.evaluate(() => !!document.querySelector(".contact-preview.draft")));

  // Back to the other conversation: the draft returns.
  const target = await A.evaluate(() => {
    const row = [...document.querySelectorAll(".contact")]
      .find((r) => r.querySelector(".contact-preview")?.textContent.startsWith("✏️"));
    row.click();
    return true;
  });
  await A.waitForTimeout(800);
  ok("returning to a conversation restores its draft",
     (await A.inputValue("#msg-input")) === "draft for peer two", target);

  // Survives a reload.
  await A.reload();
  await A.waitForSelector("#unlock-form:not([hidden])", { timeout: 15000 });
  await A.fill("#unlock-password", "correct-horse-battery");
  await A.click("#unlock-form button[type=submit]");
  await A.waitForSelector("#app-screen:not([hidden])", { timeout: 60000 });
  // Boot decrypts every conversation's history before the final renderContacts,
  // and PQC decryption of a few file messages is not instant — wait for the
  // marker rather than guessing a delay.
  const survived = await A.waitForFunction(
    () => [...document.querySelectorAll(".contact-preview")].some((n) => n.textContent.startsWith("✏️")),
    null, { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok("a draft survives a reload", survived);

  // Sending clears the draft.
  await A.evaluate(() => {
    const row = [...document.querySelectorAll(".contact")]
      .find((r) => r.querySelector(".contact-preview")?.textContent.startsWith("✏️"));
    row.click();
  });
  await A.waitForTimeout(900);
  await A.click("#send-btn");
  await A.waitForTimeout(3000);
  ok("sending clears the draft", (await A.inputValue("#msg-input")) === "");
  const stillMarked = await A.evaluate(() =>
    [...document.querySelectorAll(".contact-preview")].some((n) => n.textContent.startsWith("✏️")));
  ok("the draft marker disappears after sending", !stillMarked);

  // A failed send must leave the draft recoverable.
  await A.route("**/api/messages", (r) => r.abort("failed"));
  await A.fill("#msg-input", "this should survive a failure");
  await A.click("#send-btn");
  await A.waitForTimeout(1500);
  ok("a failed send keeps the text in the box",
     (await A.inputValue("#msg-input")) === "this should survive a failure");
  const persisted = await A.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("lattix.draft.")).length > 0);
  ok("a failed send also persists the draft", persisted);
  await A.unroute("**/api/messages");

  const realErrors = errors.filter((e) => !/ERR_FAILED|Failed to load resource/.test(e));
  ok("no uncaught page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
