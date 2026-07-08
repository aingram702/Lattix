// Lattix — application logic.

import { LattixApi } from "./api.js";
import * as C from "./crypto.js";

const VAULT_KEY = "lattix.vault";
const api = new LattixApi();

const state = {
  identity: null,        // decrypted identity (keys live only in memory)
  peers: {},             // username -> { kem_public_key, dsa_public_key, fingerprint }
  threads: {},           // username -> [ message objects ]
  current: null,         // active conversation peer
  online: new Set(),     // usernames currently connected
  seen: new Set(),       // envelope ids already rendered
  connected: false,
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
function avatarColor(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
function toast(msg, kind = "info") {
  const t = el("div", { class: `toast toast-${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
}

// ---------------------------------------------------------------------------
// Vault persistence (localStorage)
// ---------------------------------------------------------------------------
const loadStoredVault = () => {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? JSON.parse(raw) : null;
};
const storeVault = (vault) => localStorage.setItem(VAULT_KEY, JSON.stringify(vault));

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------
function showAuth() {
  $("#app-screen").hidden = true;
  $("#auth-screen").hidden = false;
  const hasVault = !!loadStoredVault();
  switchAuthTab(hasVault ? "unlock" : "create");
  $$(".auth-tab").forEach((tab) =>
    (tab.onclick = () => switchAuthTab(tab.dataset.tab))
  );

  $("#create-form").onsubmit = onCreate;
  $("#unlock-form").onsubmit = onUnlock;
  $("#import-form").onsubmit = onImport;
}

function switchAuthTab(tab) {
  $$(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $$(".auth-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
}

async function onCreate(e) {
  e.preventDefault();
  const btn = $("#create-form button[type=submit]");
  const username = $("#create-username").value.trim().toLowerCase();
  const password = $("#create-password").value;
  const confirm = $("#create-confirm").value;
  if (password.length < 8) return toast("Password must be at least 8 characters", "error");
  if (password !== confirm) return toast("Passwords do not match", "error");
  btn.disabled = true; btn.textContent = "Generating quantum-resistant keys…";
  try {
    const identity = await C.generateIdentity();
    identity.username = username;
    await api.register({
      username,
      kem_public_key: identity.kem.publicKey,
      dsa_public_key: identity.dsa.publicKey,
      fingerprint: identity.fingerprint,
      auth_secret: identity.authSecret,
    });
    const vault = await C.sealVault(identity, password);
    storeVault(vault);
    await bootApp(identity);
    toast("Account created. Keep your password safe — it cannot be recovered.", "success");
  } catch (err) {
    toast(err.message || "Registration failed", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create account";
  }
}

async function onUnlock(e) {
  e.preventDefault();
  const btn = $("#unlock-form button[type=submit]");
  const password = $("#unlock-password").value;
  const vault = loadStoredVault();
  if (!vault) return switchAuthTab("create");
  btn.disabled = true; btn.textContent = "Unlocking…";
  try {
    const identity = await C.openVault(vault, password);
    await api.login(identity.username, identity.authSecret);
    await bootApp(identity);
  } catch (err) {
    toast(err.message || "Unlock failed", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Unlock";
  }
}

async function onImport(e) {
  e.preventDefault();
  const btn = $("#import-form button[type=submit]");
  const file = $("#import-file").files[0];
  const password = $("#import-password").value;
  if (!file) return toast("Choose a vault file", "error");
  btn.disabled = true; btn.textContent = "Importing…";
  try {
    const vault = JSON.parse(await file.text());
    const identity = await C.openVault(vault, password);
    await api.login(identity.username, identity.authSecret);
    storeVault(vault);
    await bootApp(identity);
    toast("Vault imported to this device", "success");
  } catch (err) {
    toast(err.message || "Import failed", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Import vault";
  }
}

// ---------------------------------------------------------------------------
// Boot main app after auth
// ---------------------------------------------------------------------------
async function bootApp(identity) {
  state.identity = identity;
  // Cache our own public keys as a "peer" so we can verify our own signatures.
  state.peers[identity.username] = {
    kem_public_key: identity.kem.publicKey,
    dsa_public_key: identity.dsa.publicKey,
    fingerprint: identity.fingerprint,
  };

  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;

  // Identity panel
  $("#self-name").textContent = identity.username;
  $("#self-avatar").style.background = avatarColor(identity.username);
  $("#self-avatar").textContent = identity.username[0].toUpperCase();
  $("#self-fingerprint").textContent = C.prettyFingerprint(identity.fingerprint).slice(0, 29) + "…";

  wireAppEvents();

  api.on("envelope", onEnvelope)
     .on("presence", onPresence)
     .on("status", (s) => setConnected(s.connected));
  api.connectSocket();

  // Load contacts + full history
  const me = await api.me();
  for (const c of me.contacts) ensureThread(c);
  renderContacts();

  // Prime history for each contact (so unread + previews populate)
  for (const c of me.contacts) await loadConversation(c, { silent: true });
  renderContacts();
}

function setConnected(v) {
  state.connected = v;
  $("#conn-dot").className = "conn-dot " + (v ? "on" : "off");
  $("#conn-label").textContent = v ? "Connected" : "Reconnecting…";
}

// ---------------------------------------------------------------------------
// App-level event wiring
// ---------------------------------------------------------------------------
function wireAppEvents() {
  $("#logout-btn").onclick = async () => {
    await api.logout();
    location.reload();
  };
  $("#export-btn").onclick = () => {
    const vault = loadStoredVault();
    const blob = new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `lattix-${state.identity.username}.vault.json` });
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Encrypted vault exported. Guard it with your password.", "success");
  };
  $("#my-fp-btn").onclick = () => openFingerprint(state.identity.username);

  $("#new-chat-btn").onclick = () => openUserSearch();
  $("#search-close").onclick = () => ($("#search-modal").hidden = true);
  $("#fp-close").onclick = () => ($("#fp-modal").hidden = true);

  const input = $("#msg-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  $("#send-btn").onclick = sendCurrent;
  $("#attach-btn").onclick = () => $("#file-input").click();
  $("#file-input").onchange = onAttachFile;
  $("#verify-peer-btn").onclick = () => state.current && openFingerprint(state.current);
}

// ---------------------------------------------------------------------------
// Peer key resolution (cached directory lookups)
// ---------------------------------------------------------------------------
async function getPeerKeys(username) {
  if (state.peers[username]) return state.peers[username];
  const u = await api.getUser(username);
  state.peers[username] = u;
  return u;
}

// ---------------------------------------------------------------------------
// Threads / contacts
// ---------------------------------------------------------------------------
function ensureThread(username) {
  if (!state.threads[username]) state.threads[username] = { messages: [], unread: 0, maxId: 0 };
  return state.threads[username];
}

function renderContacts() {
  const list = $("#contacts");
  list.innerHTML = "";
  const peers = Object.keys(state.threads).sort((a, b) => {
    const la = lastTs(a), lb = lastTs(b);
    return lb - la;
  });
  if (peers.length === 0) {
    list.append(el("div", { class: "empty-hint" }, "No conversations yet. Start one with “New”."));
    return;
  }
  for (const p of peers) {
    const th = state.threads[p];
    const last = th.messages[th.messages.length - 1];
    const preview = last
      ? (last.kind === "file" ? `📎 ${last.file.filename}` : last.text || "")
      : "";
    const item = el("div", { class: "contact" + (p === state.current ? " active" : ""), onclick: () => selectPeer(p) },
      el("div", { class: "avatar", style: `background:${avatarColor(p)}` }, p[0].toUpperCase()),
      el("div", { class: "contact-main" },
        el("div", { class: "contact-top" },
          el("span", { class: "contact-name" }, p),
          el("span", { class: "contact-time" }, last ? fmtTime(last.ts) : "")),
        el("div", { class: "contact-preview" }, preview.slice(0, 42))),
      th.unread ? el("span", { class: "badge" }, String(th.unread)) : null
    );
    list.append(item);
  }
}
const lastTs = (p) => {
  const m = state.threads[p]?.messages;
  return m && m.length ? m[m.length - 1].ts : 0;
};

async function selectPeer(username) {
  state.current = username;
  ensureThread(username).unread = 0;
  $("#empty-state").hidden = true;
  $("#conversation").hidden = false;
  const peer = await getPeerKeys(username).catch(() => null);
  $("#peer-name").textContent = username;
  $("#peer-avatar").style.background = avatarColor(username);
  $("#peer-avatar").textContent = username[0].toUpperCase();
  $("#peer-status").textContent = state.online.has(username) ? "online" : "offline";
  $("#peer-status").className = "peer-status " + (state.online.has(username) ? "online" : "");
  await loadConversation(username);
  renderContacts();
  renderMessages();
  $("#msg-input").focus();
}

async function loadConversation(username, { silent = false } = {}) {
  const th = ensureThread(username);
  let envelopes;
  try {
    envelopes = await api.conversation(username, th.maxId);
  } catch (err) {
    if (!silent) toast("Could not load conversation", "error");
    return;
  }
  for (const env of envelopes) {
    if (state.seen.has(env.id)) continue;
    await ingestEnvelope(env, { silent: true });
  }
}

// ---------------------------------------------------------------------------
// Envelope ingestion + decryption
// ---------------------------------------------------------------------------
async function ingestEnvelope(env, { silent = false } = {}) {
  if (state.seen.has(env.id)) return;
  const me = state.identity.username;
  const peer = env.sender === me ? env.recipient : env.sender;
  const th = ensureThread(peer);

  let senderKeys;
  try {
    senderKeys = await getPeerKeys(env.sender);
  } catch {
    return; // can't resolve signer
  }

  let msg;
  try {
    if (env.kind === "message") {
      const { text, verified } = await C.decryptMessage(
        env.payload, me, state.identity.kem.secretKey, senderKeys.dsa_public_key
      );
      msg = { id: env.id, from: env.sender, ts: env.created_at, kind: "message", text, verified };
    } else if (env.kind === "file") {
      const ok = C.verifyFilePayload(env.payload, senderKeys.dsa_public_key);
      msg = {
        id: env.id, from: env.sender, ts: env.created_at, kind: "file", verified: ok,
        file: {
          file_id: env.payload.file_id, filename: env.payload.filename,
          mime: env.payload.mime, size: env.payload.size, payload: env.payload,
        },
      };
    } else {
      return;
    }
  } catch (err) {
    msg = { id: env.id, from: env.sender, ts: env.created_at, kind: "error", text: err.message, verified: false };
  }

  state.seen.add(env.id);
  th.maxId = Math.max(th.maxId, env.id);
  th.messages.push(msg);
  th.messages.sort((a, b) => a.id - b.id);

  if (env.sender !== me && peer !== state.current) th.unread++;

  if (peer === state.current && !silent) { renderMessages(); }
}

async function onEnvelope(env) {
  const before = state.current;
  await ingestEnvelope(env);
  if (state.current === before && env && (env.sender === state.current || env.recipient === state.current)) {
    renderMessages();
  }
  renderContacts();
}

function onPresence({ username, online }) {
  if (online) state.online.add(username);
  else state.online.delete(username);
  if (username === state.current) {
    $("#peer-status").textContent = online ? "online" : "offline";
    $("#peer-status").className = "peer-status " + (online ? "online" : "");
  }
}

// ---------------------------------------------------------------------------
// Rendering messages
// ---------------------------------------------------------------------------
function renderMessages() {
  const wrap = $("#messages");
  wrap.innerHTML = "";
  const th = state.threads[state.current];
  if (!th) return;
  const me = state.identity.username;
  let lastDay = "";
  for (const m of th.messages) {
    const day = new Date(m.ts * 1000).toDateString();
    if (day !== lastDay) {
      wrap.append(el("div", { class: "day-sep" }, day));
      lastDay = day;
    }
    const mine = m.from === me;
    const bubble = el("div", { class: "bubble " + (mine ? "mine" : "theirs") });
    if (m.kind === "file") bubble.append(renderFile(m));
    else if (m.kind === "error") bubble.append(el("div", { class: "msg-error" }, "⚠ " + m.text));
    else bubble.append(el("div", { class: "msg-text", html: escapeHtml(m.text).replace(/\n/g, "<br>") }));
    bubble.append(el("div", { class: "msg-meta" },
      m.verified ? el("span", { class: "verified", title: "Signature verified" }, "🔒") : el("span", { class: "unverified", title: "Not verified" }, "⚠"),
      " ", fmtTime(m.ts)));
    wrap.append(el("div", { class: "row " + (mine ? "right" : "left") }, bubble));
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function renderFile(m) {
  const box = el("div", { class: "file-card" },
    el("div", { class: "file-icon" }, "📎"),
    el("div", { class: "file-info" },
      el("div", { class: "file-name" }, m.file.filename),
      el("div", { class: "file-size" }, fmtBytes(m.file.size))),
    el("button", { class: "file-dl", onclick: () => downloadFile(m) }, "Download")
  );
  return box;
}

async function downloadFile(m) {
  try {
    toast("Downloading & decrypting…");
    const cipher = await api.downloadFile(m.file.file_id);
    const senderKeys = await getPeerKeys(m.from);
    const plain = await C.decryptFile(
      cipher, m.file.payload, state.identity.username,
      state.identity.kem.secretKey, senderKeys.dsa_public_key
    );
    const blob = new Blob([plain], { type: m.file.mime || "application/octet-stream" });
    const a = el("a", { href: URL.createObjectURL(blob), download: m.file.filename });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message || "Download failed", "error");
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function recipientsFor(peer) {
  const me = state.identity.username;
  const list = [{ username: peer, kemPub: state.peers[peer].kem_public_key }];
  if (peer !== me) list.push({ username: me, kemPub: state.identity.kem.publicKey });
  return list;
}

async function sendCurrent() {
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !state.current) return;
  try {
    await getPeerKeys(state.current);
    const payload = await C.encryptMessage(text, recipientsFor(state.current), state.identity.dsa.secretKey);
    input.value = "";
    input.style.height = "auto";
    const env = await api.sendMessage({ recipient: state.current, payload });
    await ingestEnvelope(env);
    renderMessages();
    renderContacts();
  } catch (err) {
    toast(err.message || "Send failed", "error");
  }
}

async function onAttachFile(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.current) return;
  try {
    await getPeerKeys(state.current);
    toast(`Encrypting ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = { filename: file.name, mime: file.type || "application/octet-stream", size: bytes.length };
    const { cipherBytes, payload } = await C.encryptFile(
      bytes, meta, recipientsFor(state.current), state.identity.dsa.secretKey
    );
    const { file_id } = await api.uploadFile(cipherBytes, bytes.length);
    payload.file_id = file_id;
    const env = await api.sendFileMessage({
      recipient: state.current,
      file_id, filename: meta.filename, mime: meta.mime, size: meta.size,
      payload,
    });
    await ingestEnvelope(env);
    renderMessages();
    renderContacts();
    toast("File sent (encrypted)", "success");
  } catch (err) {
    toast(err.message || "File send failed", "error");
  }
}

// ---------------------------------------------------------------------------
// User search modal
// ---------------------------------------------------------------------------
function openUserSearch() {
  const modal = $("#search-modal");
  modal.hidden = false;
  const input = $("#search-input");
  input.value = "";
  $("#search-results").innerHTML = "";
  input.focus();
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) return ($("#search-results").innerHTML = "");
      try {
        const results = await api.searchUsers(q);
        const box = $("#search-results");
        box.innerHTML = "";
        if (!results.length) { box.append(el("div", { class: "empty-hint" }, "No users found")); return; }
        for (const r of results) {
          box.append(el("div", { class: "search-item", onclick: () => {
            modal.hidden = true;
            ensureThread(r.username);
            selectPeer(r.username);
            renderContacts();
          } },
            el("div", { class: "avatar", style: `background:${avatarColor(r.username)}` }, r.username[0].toUpperCase()),
            el("div", {},
              el("div", { class: "contact-name" }, r.username),
              el("div", { class: "fp-mini" }, C.prettyFingerprint(r.fingerprint).slice(0, 24) + "…"))
          ));
        }
      } catch (err) { toast(err.message, "error"); }
    }, 220);
  };
}

// ---------------------------------------------------------------------------
// Fingerprint verification modal
// ---------------------------------------------------------------------------
async function openFingerprint(username) {
  const modal = $("#fp-modal");
  let fp, keys;
  if (username === state.identity.username) {
    fp = state.identity.fingerprint;
  } else {
    keys = await getPeerKeys(username).catch(() => null);
    if (!keys) return toast("Could not load key", "error");
    fp = keys.fingerprint;
  }
  $("#fp-title").textContent = username === state.identity.username
    ? "Your identity fingerprint"
    : `Verify ${username}`;
  $("#fp-value").textContent = C.prettyFingerprint(fp);
  $("#fp-hint").textContent = username === state.identity.username
    ? "Share this with contacts so they can confirm they're talking to you."
    : "Compare this with the value shown on their device (in person, by call, etc.). If it matches, the channel is authentic and free of a man-in-the-middle.";
  modal.hidden = false;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
showAuth();
