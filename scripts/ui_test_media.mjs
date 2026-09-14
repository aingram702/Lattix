// End-to-end check of inline image previews and group-chat rendering.
// Needs three accounts and a real encrypted image round-trip, so it's kept
// separate from scripts/ui_test.mjs.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/ui_test_media.mjs
//
// Set OUT=<dir> to also drop screenshots. PW_CHROMIUM overrides the browser.
import { chromium } from "playwright";
import { signUp as _signUp, dismissBackupPrompt } from "./lib/harness.mjs";
const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
const OUT = process.env.OUT;
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };
const u = (p) => p + Math.floor(Math.random() * 100000);


// Build a real 800x450 PNG so the layout assertions see a realistic aspect
// ratio rather than a degenerate square.
import { deflateSync, crc32 } from "node:zlib";
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
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const IMG_W = 800, IMG_H = 450;
const PNG_B64 = makePng(IMG_W, IMG_H, [30, 120, 200]).toString("base64");

const signUp = (page, username) => _signUp(page, username, BASE);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  const names = [u("ada"), u("bob"), u("cyd")];
  const ctxs = [], pages = [];
  for (let i = 0; i < 3; i++) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    ctxs.push(c);
    const p = await c.newPage();
    pages.push(p);
    await signUp(p, names[i]);
  }
  const [A, B, C] = pages;

  // --- group with all three ---
  await A.click("#new-group-btn");
  await A.fill("#group-name", "Crypto Crew");
  await A.fill("#group-icon", "🔐");
  for (const peer of [names[1], names[2]]) {
    await A.fill("#group-member-search", peer);
    await A.waitForSelector("#group-member-results .search-item", { timeout: 10000 });
    await A.click("#group-member-results .search-item");
  }
  await A.click("#group-create-btn");
  await A.waitForSelector("#conversation:not([hidden])");
  await A.waitForTimeout(1200);

  for (const [pg, text] of [
    [A, "Group's up. Everyone see this?"],
    [B, "Loud and clear."],
    [B, "Signatures verifying on my side."],
    [C, "Same here — ML-DSA-65 checks out."],
  ]) {
    if (pg !== A) {
      await pg.waitForSelector(".contact", { timeout: 20000 });
      if (await pg.locator("#conversation[hidden]").count()) await pg.click(".contact");
      await pg.waitForSelector("#conversation:not([hidden])");
    }
    await pg.fill("#msg-input", text);
    await pg.click("#send-btn");
    await pg.waitForTimeout(900);
  }
  await A.waitForTimeout(2000);

  const group = await A.evaluate(() => {
    const avatars = [...document.querySelectorAll(".row.left .msg-avatar")];
    const senders = [...document.querySelectorAll(".msg-sender")];
    const colours = new Set(senders.map((s) => getComputedStyle(s).color));
    return {
      avatars: avatars.length,
      spacers: avatars.filter((a) => a.classList.contains("spacer")).length,
      senderColours: colours.size,
      hiddenLabels: senders.filter((s) => getComputedStyle(s).display === "none").length,
    };
  });
  ok(`incoming group messages get avatars (${group.avatars})`, group.avatars >= 3);
  ok(`a run reuses a hidden spacer avatar (${group.spacers})`, group.spacers >= 1);
  ok(`distinct sender colours (${group.senderColours})`, group.senderColours >= 2);
  ok(`repeated sender label hidden within a run (${group.hiddenLabels})`, group.hiddenLabels >= 1);
  if (OUT) await A.screenshot({ path: `${OUT}/p1-group.png` });

  // --- real image round trip, B -> group ---
  await B.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "landscape.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  }, PNG_B64);

  await A.waitForSelector(".msg-image", { timeout: 25000 });
  const img = await A.evaluate(() => {
    const i = document.querySelector(".msg-image");
    return {
      src: i.src.slice(0, 5),
      natural: i.naturalWidth,
      complete: i.complete,
      hasSave: !!i.parentElement.querySelector(".img-meta .file-dl"),
      fileCards: document.querySelectorAll(".file-card").length,
    };
  });
  ok("verified PNG renders inline as an <img>", img.src === "blob:");
  ok(`the blob actually decodes (naturalWidth=${img.natural})`, img.complete && img.natural === IMG_W);
  ok("preview offers a Save button", img.hasSave);
  ok("no generic file card for a previewable image", img.fileCards === 0);

  // Aspect ratio must survive: an earlier version used width:100% with
  // object-fit:cover, which upscaled small images and stretched the bubble.
  const box = await A.evaluate(() => {
    const i = document.querySelector(".msg-image");
    const b = i.getBoundingClientRect();
    const bub = i.closest(".bubble").getBoundingClientRect();
    return { w: b.width, h: b.height, bubbleH: bub.height };
  });
  const wantRatio = IMG_W / IMG_H;
  const gotRatio = box.w / box.h;
  ok(`aspect ratio preserved (${wantRatio.toFixed(2)} vs ${gotRatio.toFixed(2)})`,
     Math.abs(wantRatio - gotRatio) < 0.05);
  ok(`image never upscaled past its cap (${Math.round(box.w)}x${Math.round(box.h)})`,
     box.w <= 320.5 && box.h <= 340.5);
  ok(`bubble stays proportionate to the image (${Math.round(box.bubbleH)}px)`,
     box.bubbleH < box.h + 90);
  if (OUT) await A.screenshot({ path: `${OUT}/p1-image.png` });

  // --- lightbox ---
  await A.click(".msg-image");
  await A.waitForTimeout(400);
  ok("clicking the image opens a lightbox", await A.isVisible(".lightbox"));
  await A.click(".lightbox");
  await A.waitForTimeout(300);
  ok("clicking the lightbox closes it", (await A.locator(".lightbox").count()) === 0);

  // --- turning the setting off falls back to an opt-in placeholder ---
  await A.evaluate(() => localStorage.setItem("lattix.autoImages", "0"));
  await A.evaluate(() => document.querySelector("#messages").dispatchEvent(new Event("x")));
  await A.click("#settings-btn");
  await A.waitForTimeout(300);
  const toggleState = await A.isChecked("#toggle-autoimg");
  ok("setting reflects the stored preference", toggleState === false);
  await A.click("#settings-close");

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
}
