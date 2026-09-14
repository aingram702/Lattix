// End-to-end integration test: real server + real client crypto module.
import * as C from "../client/js/crypto.js";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name); } };

async function req(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !raw) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res;
}

async function makeUser(name) {
  const id = await C.generateIdentity();
  id.username = name;
  const tok = await req("POST", "/api/register", { body: {
    username: name, kem_public_key: id.kem.publicKey, dsa_public_key: id.dsa.publicKey,
    fingerprint: id.fingerprint, auth_secret: id.authSecret,
  }});
  return { id, token: tok.token };
}

function recipients(a, b) {
  return [
    { username: b.id.username, kemPub: b.id.kem.publicKey },
    { username: a.id.username, kemPub: a.id.kem.publicKey },
  ];
}

console.log("\nLattix integration test\n=======================");

// unique names per run
const suffix = Date.now().toString(36);
const aliceName = "alice_" + suffix, bobName = "bob_" + suffix;

// 1. Registration
const alice = await makeUser(aliceName);
const bob = await makeUser(bobName);
ok("register two users", !!alice.token && !!bob.token);

// 2. Login (Bob re-auth with his secret)
const bobLogin = await req("POST", "/api/login", { body: { username: bobName, auth_secret: bob.id.authSecret } });
ok("login with auth secret", !!bobLogin.token);
bob.token = bobLogin.token;

// 3. Directory lookup returns Bob's public keys
const bobPub = await req("GET", `/api/users/${bobName}`, { token: alice.token });
ok("directory lookup", bobPub.kem_public_key === bob.id.kem.publicKey && bobPub.fingerprint === bob.id.fingerprint);

// 4. Alice -> Bob encrypted message
const secret = "The private key never leaves my device. 🔐 " + suffix;
const payload = await C.encryptMessage(secret, recipients(alice, bob), alice.id.dsa.secretKey);
const sent = await req("POST", "/api/messages", { token: alice.token, body: { recipient: bobName, payload } });
ok("send encrypted message", sent.id > 0 && sent.kind === "message");

// 4b. Server stored only ciphertext (no plaintext leak)
const stored = JSON.stringify(sent.payload);
ok("server stores no plaintext", !stored.includes(secret) && !stored.includes("private key"));

// 5. Bob fetches conversation, decrypts, verifies signature
const bobConvo = await req("GET", `/api/conversations/${aliceName}`, { token: bob.token });
const bobMsg = await C.decryptMessage(bobConvo[0].payload, bobName, bob.id.kem.secretKey, alice.id.dsa.publicKey);
ok("recipient decrypts + verifies", bobMsg.text === secret && bobMsg.verified);

// 6. Alice reads her own sent copy (self-wrap)
const aliceConvo = await req("GET", `/api/conversations/${bobName}`, { token: alice.token });
const aliceMsg = await C.decryptMessage(aliceConvo[0].payload, aliceName, alice.id.kem.secretKey, alice.id.dsa.publicKey);
ok("sender reads own message", aliceMsg.text === secret);

// 7. Tamper detection — flip a ciphertext bit
const tampered = JSON.parse(JSON.stringify(bobConvo[0].payload));
const ctBytes = C.b64ToBytes(tampered.ciphertext); ctBytes[0] ^= 1; tampered.ciphertext = C.bytesToB64(ctBytes);
let tamperCaught = false;
try { await C.decryptMessage(tampered, bobName, bob.id.kem.secretKey, alice.id.dsa.publicKey); }
catch { tamperCaught = true; }
ok("tampered message rejected", tamperCaught);

// 8. File sharing round-trip
const fileBytes = new Uint8Array(4096);
crypto.getRandomValues(fileBytes);
const meta = { filename: "secret-plans.bin", mime: "application/octet-stream", size: fileBytes.length };
const { cipherBytes, payload: fpayload } = await C.encryptFile(fileBytes, meta, recipients(alice, bob), alice.id.dsa.secretKey);
const form = new FormData();
form.append("file", new Blob([cipherBytes]), "blob");
form.append("size", String(fileBytes.length));
const up = await req("POST", "/api/files", { token: alice.token, body: form, raw: true });
ok("upload encrypted file", !!up.file_id);
fpayload.file_id = up.file_id;
await req("POST", "/api/messages/file", { token: alice.token, body: {
  recipient: bobName, file_id: up.file_id, filename: meta.filename, mime: meta.mime, size: meta.size, payload: fpayload,
}});
// Bob downloads + decrypts
const bobConvo2 = await req("GET", `/api/conversations/${aliceName}`, { token: bob.token });
const fileEnv = bobConvo2.find((e) => e.kind === "file");
const dlRes = await req("GET", `/api/files/${fileEnv.payload.file_id}`, { token: bob.token });
const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
const decFile = await C.decryptFile(dlBytes, fileEnv.payload, bobName, bob.id.kem.secretKey, alice.id.dsa.publicKey);
const same = decFile.length === fileBytes.length && decFile.every((b, i) => b === fileBytes[i]);
ok("file decrypts to original bytes", same);

// 9. WebSocket real-time delivery
const wsUrl = BASE.replace("http", "ws") + `/ws?token=${bob.token}`;
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl);
  let done = false;
  ws.onopen = async () => {
    // Alice sends a fresh message; expect Bob to receive it over WS.
    const p2 = await C.encryptMessage("realtime ping " + suffix, recipients(alice, bob), alice.id.dsa.secretKey);
    await req("POST", "/api/messages", { token: alice.token, body: { recipient: bobName, payload: p2 } });
  };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "envelope" && m.envelope.kind === "message") {
      const dec = await C.decryptMessage(m.envelope.payload, bobName, bob.id.kem.secretKey, alice.id.dsa.publicKey);
      done = true; ws.close(); resolve(dec.text === "realtime ping " + suffix);
    }
  };
  setTimeout(() => { if (!done) { try { ws.close(); } catch {} resolve(false); } }, 5000);
});
ok("websocket real-time delivery", wsResult);

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
