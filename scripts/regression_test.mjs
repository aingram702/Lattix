// Regression tests for the 2.2.0 review findings: relay API + client crypto.
//
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/regression_test.mjs
//
// scripts/run_all_tests.mjs runs this with a relay of its own.

import * as C from "../client/js/crypto.js";
import { ml_kem768, ml_dsa65, randomBytes } from "../client/vendor/lattix-pqc.js";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder(), td = new TextDecoder();

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  let parsed = null;
  try { parsed = await res.clone().json(); } catch (_) {}
  return { status: res.status, body: parsed, res };
}

const sfx = Date.now().toString(36) + Math.floor(Math.random() * 1000);
let seq = 0;
const uname = (p) => `${p}_${sfx}${seq++}`;

async function makeUser(prefix = "u", overrides = {}, username = uname(prefix)) {
  const id = await C.generateIdentity();
  id.username = username;
  const r = await call("POST", "/api/register", { body: {
    username, kem_public_key: id.kem.publicKey, dsa_public_key: id.dsa.publicKey,
    fingerprint: id.fingerprint, auth_secret: id.authSecret, ...overrides } });
  return { id, username, token: r.body?.token, status: r.status };
}

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    const frames = [];
    let closeCode = null;
    const timer = setTimeout(() => reject(new Error("socket never became ready")), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      frames.push(msg);
      if (msg.type === "ready") { clearTimeout(timer); resolve({ ws, frames, closed: () => closeCode }); }
    };
    ws.onclose = (ev) => { closeCode = ev.code; };
  });
}
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(50); }
  return false;
};

console.log("\nLattix 2.2 regression tests\n===========================");

// ---------------------------------------------------------------- directory
console.log("\n— directory integrity");
{
  const bad = await makeUser("fpbad", { fingerprint: "ab".repeat(32) });
  ok("a fingerprint that doesn't match the keys is refused (422)", bad.status === 422, `got ${bad.status}`);
  const other = await C.generateIdentity();
  const swapped = await makeUser("fpswap", { fingerprint: other.fingerprint });
  ok("publishing someone else's fingerprint is refused", swapped.status === 422, `got ${swapped.status}`);
  const short = await makeUser("short", { kem_public_key: C.bytesToB64(randomBytes(32)) });
  ok("a KEM key of the wrong size is refused", short.status === 422, `got ${short.status}`);
  const good = await makeUser("good");
  ok("a well-formed registration still succeeds", good.status === 200);

  // Two registrations for one name at once: one wins, the rest get 409, none 500.
  const name = uname("race");
  const results = await Promise.all([0, 1, 2, 3].map(() => makeUser("race", {}, name)));
  const codes = results.map((r) => r.status).sort();
  ok("racing registrations yield one 200 and 409s — never a 500",
     codes.filter((c) => c === 200).length === 1 && codes.every((c) => c === 200 || c === 409),
     codes.join(","));
}

// ---------------------------------------------------------------- health
console.log("\n— health / capabilities");
{
  const h = await call("GET", "/api/health");
  ok("health advertises history_page_size", Number.isInteger(h.body?.history_page_size) && h.body.history_page_size > 0);
  ok("health lists the history-paging feature", (h.body?.features || []).includes("history-paging"));
  // The schema lives beside the docs, so LATTIX_DOCS_URL="" hides both.
  ok("FastAPI's default /redoc is not exposed", (await call("GET", "/redoc")).status === 404);
  ok("the schema is not exposed at the default /openapi.json",
     !((await call("GET", "/openapi.json")).body?.openapi));
  ok("the schema is served under /api/ when docs are on", !!(await call("GET", "/api/openapi.json")).body?.openapi);
}

// ---------------------------------------------------------------- groups
console.log("\n— groups");
{
  const u = await makeUser("gv");
  const r1 = await call("POST", "/api/groups", { token: u.token, body: { name: "x", members: ["a".repeat(5000)] } });
  ok("a group roster entry that isn't a username is refused", r1.status === 422, `got ${r1.status}`);
  const r2 = await call("POST", "/api/groups", { token: u.token, body: { name: "x", members: ["no spaces!"] } });
  ok("an invalid roster name is refused", r2.status === 422, `got ${r2.status}`);

  const owner = await makeUser("own"), m1 = await makeUser("m1"), m2 = await makeUser("m2");
  const g = await call("POST", "/api/groups", { token: owner.token, body: { name: "team", members: [m1.username] } });
  await sleep(20);
  await call("POST", `/api/groups/${g.body.id}/members`, { token: owner.token, body: { username: m2.username } });
  const sock = await openSocket(m1.token);
  const del = await call("DELETE", "/api/me", { token: owner.token });
  ok("the owner can delete their account", del.status === 200);
  const after = await call("GET", `/api/groups/${g.body.id}`, { token: m1.token });
  ok("the group survives its owner's account deletion", after.status === 200, `got ${after.status}`);
  ok("ownership passes to the longest-standing member", after.body?.owner === m1.username, after.body?.owner);
  ok("the departed owner is no longer a member",
     !(after.body?.members || []).some((m) => m.username === owner.username));
  ok("remaining members are told the roster changed",
     await waitFor(() => sock.frames.some((f) => f.type === "group" && f.action === "members" && f.group_id === g.body.id)));
  const kick = await call("DELETE", `/api/groups/${g.body.id}/members/${m2.username}`, { token: m1.token });
  ok("the new owner can manage the roster", kick.status === 200, `got ${kick.status}`);
  sock.ws.close();
}

// ---------------------------------------------------------------- account deletion
console.log("\n— account deletion");
{
  const gone = await makeUser("gone"), peer = await makeUser("peer");
  const rec = [{ username: peer.username, kemPub: peer.id.kem.publicKey }, { username: gone.username, kemPub: gone.id.kem.publicKey }];
  await call("POST", "/api/messages", { token: gone.token, body: { recipient: peer.username,
    payload: await C.encryptMessage("hi", rec, gone.id.dsa.secretKey) } });
  const goneSock = await openSocket(gone.token);
  const peerSock = await openSocket(peer.token);
  await call("DELETE", "/api/me", { token: gone.token });
  ok("a deleted account's open socket is closed (4401)", await waitFor(() => goneSock.closed() === 4401), `code ${goneSock.closed()}`);
  ok("contacts are told the deleted account went offline",
     await waitFor(() => peerSock.frames.some((f) => f.type === "presence" && f.username === gone.username && f.online === false)));
  peerSock.ws.close();
}

// ---------------------------------------------------------------- websocket robustness
console.log("\n— websocket");
{
  const u = await makeUser("bin");
  const s = await openSocket(u.token);
  s.ws.send(new Uint8Array([1, 2, 3]));
  await sleep(200);
  s.ws.send("ping");
  ok("a binary frame doesn't break the socket (ping still answered)",
     await waitFor(() => s.frames.some((f) => f.type === "pong")));
  s.ws.close();
}

// ---------------------------------------------------------------- history paging
console.log("\n— history paging");
{
  const page = (await call("GET", "/api/health")).body.history_page_size;
  const a = await makeUser("ha"), b = await makeUser("hb");
  const rec = [{ username: b.username, kemPub: b.id.kem.publicKey }, { username: a.username, kemPub: a.id.kem.publicKey }];
  const payload = await C.encryptMessage("x", rec, a.id.dsa.secretKey);
  const total = page + 7;
  for (let i = 0; i < total; i++) {
    await call("POST", "/api/messages", { token: a.token, body: { recipient: b.username, payload } });
  }
  let since = 0, got = 0, calls = 0;
  for (;;) {
    const r = await call("GET", `/api/conversations/${a.username}?since=${since}`, { token: b.token });
    calls++; got += r.body.length;
    if (r.body.length < page) break;
    since = r.body[r.body.length - 1].id;
  }
  ok(`paging with since= retrieves all ${total} envelopes`, got === total, `got ${got} in ${calls} calls`);
}

// ---------------------------------------------------------------- file format v2
console.log("\n— file format v2");
{
  const alice = await makeUser("fa"), bob = await makeUser("fb"), mal = await makeUser("fm");
  const g = await call("POST", "/api/groups", { token: alice.token, body: { name: "f", members: [bob.username, mal.username] } });
  const ctx = "g:" + g.body.id;
  const rec = [alice, bob, mal].map((u) => ({ username: u.username, kemPub: u.id.kem.publicKey }));
  const secretName = "salary-review-" + sfx + ".pdf";
  const bytes = te.encode("REAL CONTENT");
  const { cipherBytes, payload } = await C.encryptFile(bytes, { filename: secretName, mime: "application/pdf", size: bytes.length },
                                                       rec, alice.id.dsa.secretKey, ctx);
  const form = new FormData();
  form.append("file", new Blob([cipherBytes]), "blob");
  form.append("size", String(bytes.length));
  const up = await call("POST", "/api/files", { token: alice.token, form });
  const sent = await call("POST", `/api/groups/${g.body.id}/messages/file`, { token: alice.token, body: {
    file_id: up.body.file_id, filename: "file", mime: "application/octet-stream", size: bytes.length, payload } });
  ok("a v2 file message is accepted", sent.status === 200, `got ${sent.status}`);

  const stored = await call("GET", `/api/groups/${g.body.id}/messages`, { token: bob.token });
  const env = stored.body.find((e) => e.kind === "file");
  const raw = JSON.stringify(env);
  ok("the relay never sees the filename", !raw.includes(secretName) && !raw.includes("salary"));
  ok("the relay never sees the MIME type", !raw.includes("application/pdf"));

  const opened = await C.openFilePayload(env.payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx);
  ok("the recipient recovers name, type and size", opened.meta.filename === secretName &&
     opened.meta.mime === "application/pdf" && opened.meta.size === bytes.length && opened.verified && !opened.legacy);

  const blob = new Uint8Array(await (await call("GET", `/api/files/${up.body.file_id}`, { token: bob.token })).res.arrayBuffer());
  const plain = await C.decryptFile(blob, env.payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx);
  ok("the recipient decrypts the file", td.decode(plain) === "REAL CONTENT");

  // The attack that worked on v1: a member re-encrypts other bytes under the CEK.
  const entry = payload.keys[mal.username];
  const ss = ml_kem768.decapsulate(C.b64ToBytes(entry.kem_ct), C.b64ToBytes(mal.id.kem.secretKey));
  const base = await crypto.subtle.importKey("raw", ss, "HKDF", false, ["deriveKey"]);
  const kek = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("lattix-wrap-v1") },
                                            base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const cekRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: C.b64ToBytes(entry.iv) }, kek, C.b64ToBytes(entry.wrapped)));
  const cek = await crypto.subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const forged = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: C.b64ToBytes(payload.iv) }, cek, te.encode("EVIL CONTENT")));
  let forgedAccepted = true;
  try { await C.decryptFile(forged, payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx); }
  catch { forgedAccepted = false; }
  ok("a group member can't substitute the file bytes under the sender's signature", !forgedAccepted);

  let replay = true;
  try { await C.openFilePayload(payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, "g:999999"); }
  catch { replay = false; }
  ok("a v2 file envelope can't be replayed into another group", !replay);

  const downgraded = { ...payload, v: undefined, filename: secretName, mime: "application/pdf", size: bytes.length };
  delete downgraded.v;
  const dg = await C.openFilePayload(downgraded, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx);
  ok("stripping v2 down to v1 shape doesn't verify", dg.verified === false && dg.legacy === true);

  // Legacy v1 payloads (history from 2.1.x) still open.
  const v1 = await legacyEncryptFile(te.encode("old"), { filename: "old.txt", mime: "text/plain", size: 3 },
                                     rec, alice.id.dsa.secretKey, ctx);
  const o1 = await C.openFilePayload(v1.payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx);
  ok("a legacy v1 file payload still verifies and shows its name", o1.verified && o1.legacy && o1.meta.filename === "old.txt");
  const p1 = await C.decryptFile(v1.cipherBytes, v1.payload, bob.username, bob.id.kem.secretKey, alice.id.dsa.publicKey, ctx);
  ok("a legacy v1 file still decrypts", td.decode(p1) === "old");
}

// ---------------------------------------------------------------- vault KDF
console.log("\n— vault");
{
  const v = await C.sealVault({ username: "x" }, "pw-123456");
  ok("new vaults record their KDF and iteration count", v.v === 2 && v.kdf === "pbkdf2-sha256" && v.iter === C.VAULT_ITERATIONS);
  ok("the work factor is at least 600k", C.VAULT_ITERATIONS >= 600_000);
  ok("a current vault doesn't need upgrading", C.vaultNeedsUpgrade(v) === false);
  const legacy = await legacySealVault({ username: "old" }, "pw-123456");
  ok("a 2.1.x vault (no iter) is flagged for upgrade", C.vaultNeedsUpgrade(legacy) === true);
  ok("a 2.1.x vault still opens", (await C.openVault(legacy, "pw-123456")).username === "old");
  let refused = false;
  try { await C.openVault({ ...v, iter: 1e12 }, "pw-123456"); } catch { refused = true; }
  ok("an absurd iteration count from a tampered file is refused", refused);
  const b = await C.sealBackup({ a: 1 }, "pw-123456");
  ok("backups use the same work factor", b.iter === C.VAULT_ITERATIONS && (await C.openBackup(b, "pw-123456")).a === 1);
}

// ---- helpers reproducing the 2.1.x formats, for compatibility checks ----
async function legacyEncryptFile(fileBytes, meta, recipients, dsaSk, context) {
  const cekRaw = randomBytes(32);
  const cek = await crypto.subtle.importKey("raw", cekRaw, "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  const cipherBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cek, fileBytes));
  const keys = {};
  for (const r of recipients) {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(C.b64ToBytes(r.kemPub));
    const base = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    const kek = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("lattix-wrap-v1") },
                                              base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const kiv = randomBytes(12);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: kiv }, kek, cekRaw));
    keys[r.username] = { kem_ct: C.bytesToB64(cipherText), iv: C.bytesToB64(kiv), wrapped: C.bytesToB64(wrapped) };
  }
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let off = 0; for (const x of a) { o.set(x, off); off += x.length; } return o; };
  let t = cat(te.encode(context + JSON.stringify({ filename: meta.filename, mime: meta.mime, size: meta.size })), iv);
  for (const u of Object.keys(keys).sort()) {
    const k = keys[u];
    t = cat(t, te.encode(u), C.b64ToBytes(k.kem_ct), C.b64ToBytes(k.iv), C.b64ToBytes(k.wrapped));
  }
  const signature = ml_dsa65.sign(C.b64ToBytes(dsaSk), t);
  return { cipherBytes, payload: { ...meta, iv: C.bytesToB64(iv), keys, signature: C.bytesToB64(signature) } };
}
async function legacySealVault(identity, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
                                            base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(identity))));
  return { v: 1, salt: C.bytesToB64(salt), iv: C.bytesToB64(iv), ciphertext: C.bytesToB64(ct) };
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
