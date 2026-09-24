// Relay behaviour tests — the server-side rules that no browser test exercises:
// input validation on the public directory, group ownership succession, file
// access control, presence across multiple sessions, and session invalidation.
//
//   pip install -r requirements.txt
//   LATTIX_RATE_LIMIT_MAX=0 python -m uvicorn server.main:app --port 8111 &
//   LATTIX_BASE=http://127.0.0.1:8111 node scripts/server_test.mjs
//
// scripts/run_all_tests.mjs runs this with a relay of its own.

import * as C from "../client/js/crypto.js";

const BASE = process.env.LATTIX_BASE || "http://127.0.0.1:8111";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw request — returns { status, body } instead of throwing, so the tests
 *  can assert on rejections as easily as on successes. */
async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const ct = res.headers.get("content-type") || "";
  let parsed = null;
  if (ct.includes("json")) { try { parsed = await res.json(); } catch (_) {} }
  return { status: res.status, body: parsed, res };
}

const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1000);
let seq = 0;
const name = (p) => `${p}_${suffix}${seq++}`;

async function makeUser(username = name("u")) {
  const id = await C.generateIdentity();
  id.username = username;
  const r = await call("POST", "/api/register", { body: {
    username, kem_public_key: id.kem.publicKey, dsa_public_key: id.dsa.publicKey,
    fingerprint: id.fingerprint, auth_secret: id.authSecret,
  }});
  if (r.status !== 200) throw new Error(`register ${username} -> ${r.status}`);
  return { id, username, token: r.body.token };
}

/** Open an authenticated socket and collect the frames it receives. */
function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    const frames = [];
    const timer = setTimeout(() => reject(new Error("socket never became ready")), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      frames.push(m);
      if (m.type === "ready") { clearTimeout(timer); resolve({ ws, frames }); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); };
  });
}

console.log("\nLattix relay behaviour tests\n============================");

// --------------------------------------------------------------------------
console.log("\nDirectory input validation");
// --------------------------------------------------------------------------
{
  const good = await C.generateIdentity();
  const base = {
    kem_public_key: good.kem.publicKey, dsa_public_key: good.dsa.publicKey,
    fingerprint: good.fingerprint, auth_secret: good.authSecret,
  };

  const bigKey = await call("POST", "/api/register", {
    body: { ...base, username: name("big"), kem_public_key: "A".repeat(9000) },
  });
  ok("an oversized public key is refused", bigKey.status === 422, `got ${bigKey.status}`);

  const notB64 = await call("POST", "/api/register", {
    body: { ...base, username: name("b64"), dsa_public_key: "this is not base64!!" },
  });
  ok("a non-base64 public key is refused", notB64.status === 422, `got ${notB64.status}`);

  const badFp = await call("POST", "/api/register", {
    body: { ...base, username: name("fp"), fingerprint: "nope" },
  });
  ok("a malformed fingerprint is refused", badFp.status === 422, `got ${badFp.status}`);

  const good2 = await call("POST", "/api/register", { body: { ...base, username: name("okuser") } });
  ok("well-formed key material is accepted", good2.status === 200, `got ${good2.status}`);
}

// --------------------------------------------------------------------------
console.log("\nFile blobs");
// --------------------------------------------------------------------------
const alice = await makeUser(name("alice"));
const bob = await makeUser(name("bob"));
const mallory = await makeUser(name("mallory"));
{
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(64)]), "blob");
  form.append("size", "-1");
  const bad = await call("POST", "/api/files", { token: alice.token, form });
  ok("a negative plaintext size is refused", bad.status === 400, `got ${bad.status}`);

  const form2 = new FormData();
  form2.append("file", new Blob([new Uint8Array(64)]), "blob");
  form2.append("size", "64");
  const up = await call("POST", "/api/files", { token: alice.token, form: form2 });
  ok("a well-formed upload is accepted", up.status === 200, `got ${up.status}`);

  const theft = await call("GET", `/api/files/${up.body.file_id}`, { token: mallory.token });
  ok("an unrelated user cannot fetch the blob", theft.status === 404, `got ${theft.status}`);

  const own = await call("GET", `/api/files/${up.body.file_id}`, { token: alice.token });
  ok("the uploader can fetch their own blob", own.status === 200, `got ${own.status}`);

  // A leaked file_id must not become a capability: posting a file message that
  // references someone else's blob used to make the poster its "sender", which
  // user_can_access_file() then honoured.
  const meta = { file_id: up.body.file_id, filename: "x", mime: "application/octet-stream", size: 64, payload: {} };
  const claim = await call("POST", "/api/messages/file",
    { token: mallory.token, body: { recipient: bob.username, ...meta } });
  ok("a file message can't reference a blob the sender didn't upload",
     claim.status === 404, `got ${claim.status}`);
  const after = await call("GET", `/api/files/${up.body.file_id}`, { token: mallory.token });
  ok("…so the blob stays out of reach", after.status === 404, `got ${after.status}`);

  const legit = await call("POST", "/api/messages/file",
    { token: alice.token, body: { recipient: bob.username, ...meta } });
  ok("the uploader can still send it", legit.status === 200, `got ${legit.status}`);
  const recv = await call("GET", `/api/files/${up.body.file_id}`, { token: bob.token });
  ok("and the recipient can fetch it", recv.status === 200, `got ${recv.status}`);

  const huge = await call("POST", "/api/messages/file",
    { token: alice.token, body: { recipient: bob.username, ...meta, filename: "f".repeat(5000) } });
  ok("oversized file metadata is refused", huge.status === 422, `got ${huge.status}`);
}

// --------------------------------------------------------------------------
console.log("\nGroups");
// --------------------------------------------------------------------------
{
  const carol = await makeUser(name("carol"));
  const created = await call("POST", "/api/groups", {
    token: alice.token, body: { name: "Succession", members: [bob.username, carol.username] },
  });
  ok("group created", created.status === 200, `got ${created.status}`);
  const gid = created.body.id;
  ok("the creator owns it", created.body.owner === alice.username);

  const dupes = await call("POST", "/api/groups", {
    token: alice.token,
    body: { name: "Dupes", members: [bob.username, bob.username, bob.username.toUpperCase()] },
  });
  ok("duplicate members collapse to one roster entry",
     dupes.body?.members?.filter((m) => m.username === bob.username).length === 1);

  const notMine = await call("POST", `/api/groups/${gid}/members`, {
    token: bob.token, body: { username: mallory.username },
  });
  ok("a non-owner cannot add members", notMine.status === 403, `got ${notMine.status}`);

  // The owner leaves — the group must stay administrable.
  const left = await call("DELETE", `/api/groups/${gid}/members/${alice.username}`, { token: alice.token });
  ok("the owner can leave", left.status === 200, `got ${left.status}`);

  const after = await call("GET", `/api/groups/${gid}`, { token: bob.token });
  ok("the group survives the owner leaving", after.status === 200, `got ${after.status}`);
  ok("ownership passed to a remaining member",
     after.body && after.body.owner !== alice.username &&
     after.body.members.some((m) => m.username === after.body.owner),
     `owner is ${after.body?.owner}`);

  const newOwner = after.body.owner === bob.username ? bob : carol;
  const add = await call("POST", `/api/groups/${gid}/members`, {
    token: newOwner.token, body: { username: mallory.username },
  });
  ok("the new owner can administer the group", add.status === 200, `got ${add.status}`);

  // Everyone leaves — the group should go, not linger ownerless.
  for (const u of [bob, carol, mallory]) {
    await call("DELETE", `/api/groups/${gid}/members/${u.username}`, { token: u.token });
  }
  const gone = await call("GET", `/api/groups/${gid}`, { token: bob.token });
  ok("the group is gone once the last member leaves", gone.status === 404, `got ${gone.status}`);
}

// --------------------------------------------------------------------------
console.log("\nPresence across multiple sessions");
// --------------------------------------------------------------------------
{
  const dave = await makeUser(name("dave"));
  const erin = await makeUser(name("erin"));

  // Exchanging one envelope is what makes two accounts contacts, and presence
  // is only published to contacts.
  const payload = await C.encryptMessage("hello", [
    { username: erin.username, kemPub: erin.id.kem.publicKey },
    { username: dave.username, kemPub: dave.id.kem.publicKey },
  ], dave.id.dsa.secretKey);
  await call("POST", "/api/messages", {
    token: dave.token, body: { recipient: erin.username, payload },
  });

  const watcher = await openSocket(erin.token);
  const tab1 = await openSocket(dave.token);
  const tab2 = await openSocket(dave.token);
  await sleep(300);
  watcher.frames.length = 0;

  // Dave closes one of his two tabs. He is still online.
  tab1.ws.close();
  await sleep(600);
  const falseOffline = watcher.frames.some(
    (f) => f.type === "presence" && f.username === dave.username && f.online === false);
  ok("closing one of two sessions does not report the user offline", !falseOffline);

  // Closing the last one does.
  tab2.ws.close();
  await sleep(600);
  const realOffline = watcher.frames.some(
    (f) => f.type === "presence" && f.username === dave.username && f.online === false);
  ok("closing the last session reports the user offline", realOffline);
  watcher.ws.close();
}

// --------------------------------------------------------------------------
console.log("\nSessions");
// --------------------------------------------------------------------------
{
  const gone = await makeUser(name("gone"));
  const stillOk = await call("GET", "/api/me", { token: gone.token });
  ok("/api/me works for a live account", stillOk.status === 200, `got ${stillOk.status}`);

  const del = await call("DELETE", "/api/me", { token: gone.token });
  ok("the account deletes", del.status === 200, `got ${del.status}`);

  const after = await call("GET", "/api/me", { token: gone.token });
  ok("a token for a deleted account is rejected, not a 500",
     after.status === 401, `got ${after.status}`);

  const badWs = await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    const t = setTimeout(() => { try { ws.close(); } catch (_) {} resolve(0); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "not-a-real-token" }));
    ws.onclose = (ev) => { clearTimeout(t); resolve(ev.code); };
  });
  ok("a socket with a bad token closes with 4401", badWs === 4401, `got ${badWs}`);
}

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
