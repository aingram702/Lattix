// Lattix — application logic.

import { LattixApi } from "./api.js";
import * as C from "./crypto.js";
import { isExtension, getServerUrl, setServerUrl, shareOrigin } from "./config.js";
import {
  initAppearance, applyTheme, currentTheme, applyChatColor, currentChatColor,
} from "./theme.js";
import { playSent, playReceived, soundsEnabled, setSounds } from "./sound.js";
import { encodeText, ECC } from "./qr.js";

const VAULT_KEY = "lattix.vault";
const BLOCK_KEY = "lattix.blocked";
const NOTIFY_KEY = "lattix.notify";
const api = new LattixApi();

const state = {
  identity: null,        // decrypted identity (keys live only in memory)
  peers: {},             // username -> { kem_public_key, dsa_public_key, fingerprint, avatar }
  convos: {},            // cid -> { cid, type:'dm'|'group', id, meta, messages, unread, maxId }
  current: null,         // active conversation id (cid)
  online: new Set(),
  seen: new Set(),       // dedup keys ("d<id>" for dm, "g<gid>:<id>" for group)
  blocked: loadBlocked(),
  connected: false,
  pendingAdd: null,      // deep-link: username to open after boot
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
function download(name, text, type = "application/json") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Render an avatar into an existing node (image if available, else colored initial).
function fillAvatar(node, { name, avatar, group = false, icon = null }) {
  node.innerHTML = "";
  node.style.backgroundImage = "";
  node.classList.toggle("group", group);
  if (avatar) {
    node.style.background = "";
    node.append(el("img", { src: avatar, alt: "" }));
  } else {
    node.style.background = avatarColor(name || "?");
    node.textContent = group ? (icon || (name || "#")[0]) : (name || "?")[0].toUpperCase();
  }
}
function avatarEl(opts, extraClass = "") {
  const node = el("div", { class: "avatar " + extraClass });
  fillAvatar(node, opts);
  return node;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
const loadStoredVault = () => {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? JSON.parse(raw) : null;
};
const storeVault = (vault) => localStorage.setItem(VAULT_KEY, JSON.stringify(vault));

function loadBlocked() {
  try { return new Set(JSON.parse(localStorage.getItem(BLOCK_KEY) || "[]")); }
  catch { return new Set(); }
}
const saveBlocked = () => localStorage.setItem(BLOCK_KEY, JSON.stringify([...state.blocked]));

const ttlKey = (cid) => `lattix.ttl.${cid}`;
const getTtl = (cid) => parseInt(localStorage.getItem(ttlKey(cid)) || "0", 10) || 0;
const setTtlPref = (cid, sec) => sec
  ? localStorage.setItem(ttlKey(cid), String(sec))
  : localStorage.removeItem(ttlKey(cid));

// ---------------------------------------------------------------------------
// Auth screen (create / unlock / import)
// ---------------------------------------------------------------------------
function showAuth() {
  $("#app-screen").hidden = true;
  $("#auth-screen").hidden = false;
  document.body.classList.remove("chat-open");

  $$(".pw-toggle").forEach((btn) => {
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.textContent = reveal ? "Hide" : "Show";
    };
  });
  $$("[data-goto]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); switchAuthView(a.dataset.goto); };
  });

  $("#create-form").onsubmit = onCreate;
  $("#unlock-form").onsubmit = onUnlock;
  $("#import-form").onsubmit = onImport;

  switchAuthView(loadStoredVault() ? "unlock" : "create");
}

function switchAuthView(name) {
  $$(".auth-form").forEach((f) => (f.hidden = f.id !== `${name}-form`));
  const firstField = { create: "#create-username", unlock: "#unlock-password", import: "#import-file" }[name];
  const node = firstField && $(firstField);
  if (node) setTimeout(() => node.focus(), 0);
}

async function onCreate(e) {
  e.preventDefault();
  const btn = $("#create-form button[type=submit]");
  const username = $("#create-username").value.trim().toLowerCase();
  const password = $("#create-password").value;
  if (password.length < 8) return toast("Password must be at least 8 characters", "error");
  btn.disabled = true; btn.textContent = "Setting up your account…";
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
  if (!vault) return switchAuthView("create");
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
  state.peers[identity.username] = {
    kem_public_key: identity.kem.publicKey,
    dsa_public_key: identity.dsa.publicKey,
    fingerprint: identity.fingerprint,
    avatar: identity.avatar || null,
  };

  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;

  wireAppEvents();

  api.on("envelope", (env) => onEnvelope(env, "dm"))
     .on("group_envelope", (env) => onEnvelope(env, "group"))
     .on("group", onGroupEvent)
     .on("presence", onPresence)
     .on("status", (s) => setConnected(s.connected));
  api.connectSocket();

  const me = await api.me();
  identity.avatar = me.avatar || identity.avatar || null;
  state.peers[identity.username].avatar = identity.avatar;
  renderSelf();

  for (const c of me.contacts) ensureDmConvo(c);
  for (const g of (me.groups || [])) ensureGroupConvo(g);
  renderContacts();

  for (const c of me.contacts) await loadDm(c, { live: false });
  for (const g of (me.groups || [])) await loadGroup(g.id, { live: false });
  renderContacts();

  processDeepLink();
}

function renderSelf() {
  const id = state.identity;
  $("#self-name").textContent = id.username;
  fillAvatar($("#self-avatar"), { name: id.username, avatar: id.avatar });
  $("#self-avatar").classList.add("lg");
  $("#self-fingerprint").textContent = C.prettyFingerprint(id.fingerprint).slice(0, 29) + "…";
}

function setConnected(v) {
  state.connected = v;
  $("#conn-dot").className = "conn-dot " + (v ? "on" : "off");
  $("#conn-label").textContent = v ? "Connected" : "Reconnecting…";
}

// ---------------------------------------------------------------------------
// App-level event wiring (bound once)
// ---------------------------------------------------------------------------
function wireAppEvents() {
  $("#logout-btn").onclick = async () => { await api.logout(); location.reload(); };
  $("#settings-btn").onclick = openSettings;
  $("#share-btn").onclick = openShare;

  $("#back-btn").onclick = () => {
    document.body.classList.remove("chat-open");
    state.current = null;
    renderContacts();
  };

  $("#new-chat-btn").onclick = () => openUserSearch();
  $("#new-group-btn").onclick = () => openGroupCreate();
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
  $("#verify-peer-btn").onclick = () => {
    const c = curConvo();
    if (c && c.type === "dm") openFingerprint(c.id);
    else if (c) openGroupInfo(c);
  };
  $("#menu-btn").onclick = toggleChatMenu;
  document.addEventListener("click", (e) => {
    if (!$("#chat-menu").hidden && !e.target.closest(".header-actions")) $("#chat-menu").hidden = true;
  });

  wireSettings();
  wireGroupModals();
  wireShareModal();
  wireTtlModal();
}

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------
const dmCid = (username) => username;
const groupCid = (id) => "group:" + id;
const isGroupCid = (cid) => typeof cid === "string" && cid.startsWith("group:");
const curConvo = () => (state.current ? state.convos[state.current] : null);

function ensureDmConvo(username) {
  const cid = dmCid(username);
  if (!state.convos[cid]) {
    state.convos[cid] = { cid, type: "dm", id: username, meta: null, messages: [], unread: 0, maxId: 0 };
  }
  return state.convos[cid];
}
function ensureGroupConvo(g) {
  const cid = groupCid(g.id);
  if (!state.convos[cid]) {
    state.convos[cid] = { cid, type: "group", id: g.id, meta: g, messages: [], unread: 0, maxId: 0 };
  } else {
    state.convos[cid].meta = { ...state.convos[cid].meta, ...g };
  }
  return state.convos[cid];
}

async function getPeerKeys(username) {
  if (state.peers[username]) return state.peers[username];
  const u = await api.getUser(username);
  state.peers[username] = u;
  return u;
}

async function ensureGroupLoaded(id) {
  const cid = groupCid(id);
  const detail = await api.getGroup(id);
  const convo = ensureGroupConvo(detail);
  convo.meta = detail;
  for (const m of detail.members) state.peers[m.username] = { ...state.peers[m.username], ...m };
  return convo;
}

// ---------------------------------------------------------------------------
// Contacts / sidebar
// ---------------------------------------------------------------------------
function lastTs(cid) {
  const m = state.convos[cid]?.messages;
  return m && m.length ? m[m.length - 1].ts : 0;
}
function renderContacts() {
  const list = $("#contacts");
  list.innerHTML = "";
  const cids = Object.keys(state.convos)
    .filter((cid) => !(state.convos[cid].type === "dm" && state.blocked.has(cid)))
    .sort((a, b) => lastTs(b) - lastTs(a));
  if (cids.length === 0) {
    list.append(el("div", { class: "empty-hint" }, "No conversations yet. Start a chat or group."));
    return;
  }
  for (const cid of cids) {
    const c = state.convos[cid];
    const last = c.messages[c.messages.length - 1];
    const name = c.type === "group" ? c.meta?.name || "Group" : c.id;
    let preview = "";
    if (last) {
      const who = c.type === "group" && last.from !== state.identity.username ? `${last.from}: ` : "";
      preview = who + (last.kind === "file" ? `📎 ${last.file.filename}` : last.text || "");
    }
    const avatar = c.type === "group"
      ? avatarEl({ name, group: true, icon: c.meta?.icon })
      : avatarEl({ name, avatar: state.peers[c.id]?.avatar });
    const item = el("div", { class: "contact" + (cid === state.current ? " active" : ""), onclick: () => selectConversation(cid) },
      avatar,
      el("div", { class: "contact-main" },
        el("div", { class: "contact-top" },
          el("span", { class: "contact-name" }, (c.type === "group" ? "👥 " : "") + name),
          el("span", { class: "contact-time" }, last ? fmtTime(last.ts) : "")),
        el("div", { class: "contact-preview" }, preview.slice(0, 42))),
      c.unread ? el("span", { class: "badge" }, String(c.unread)) : null
    );
    list.append(item);
  }
}

async function selectConversation(cid) {
  state.current = cid;
  const c = state.convos[cid];
  c.unread = 0;
  $("#empty-state").hidden = true;
  $("#conversation").hidden = false;
  document.body.classList.add("chat-open");
  $("#chat-menu").hidden = true;

  if (c.type === "group") {
    try { await ensureGroupLoaded(c.id); } catch (_) {}
    const g = c.meta;
    fillAvatar($("#peer-avatar"), { name: g.name, group: true, icon: g.icon });
    $("#peer-name").textContent = "👥 " + g.name;
    $("#peer-status").textContent = `${g.members.length} member${g.members.length === 1 ? "" : "s"}`;
    $("#peer-status").className = "peer-status";
    $("#verify-peer-btn").textContent = "Info";
    await loadGroup(c.id);
  } else {
    await getPeerKeys(c.id).catch(() => null);
    fillAvatar($("#peer-avatar"), { name: c.id, avatar: state.peers[c.id]?.avatar });
    $("#peer-name").textContent = c.id;
    $("#peer-status").textContent = state.online.has(c.id) ? "online" : "offline";
    $("#peer-status").className = "peer-status " + (state.online.has(c.id) ? "online" : "");
    $("#verify-peer-btn").textContent = "Verify";
    await loadDm(c.id);
  }
  renderContacts();
  renderMessages();
  $("#msg-input").focus();
}

// ---------------------------------------------------------------------------
// Loading history
// ---------------------------------------------------------------------------
async function loadDm(username, { live = true } = {}) {
  const c = ensureDmConvo(username);
  let envelopes;
  try { envelopes = await api.conversation(username, c.maxId); }
  catch { if (live) toast("Could not load conversation", "error"); return; }
  for (const env of envelopes) await ingestDm(env, { live: false });
}
async function loadGroup(id, { live = true } = {}) {
  const c = ensureGroupConvo({ id });
  let envelopes;
  try { envelopes = await api.groupMessages(id, c.maxId); }
  catch { if (live) toast("Could not load group", "error"); return; }
  for (const env of envelopes) await ingestGroup(env, { live: false });
}

// ---------------------------------------------------------------------------
// Envelope ingestion + decryption
// ---------------------------------------------------------------------------
function pushMessage(convo, msg, key, env, live) {
  state.seen.add(key);
  convo.maxId = Math.max(convo.maxId, env.id);
  convo.messages.push(msg);
  convo.messages.sort((a, b) => a.id - b.id);
  scheduleExpiry(convo, key, env);

  const mine = msg.from === state.identity.username;
  if (live && !mine) {
    if (convo.cid !== state.current) convo.unread++;
    playReceived();
    maybeNotify(convo, msg);
  }
  if (convo.cid === state.current) renderMessages();
  renderContacts();
}

function scheduleExpiry(convo, key, env) {
  if (!env.expires_at) return;
  const ms = env.expires_at * 1000 - Date.now();
  const remove = () => {
    convo.messages = convo.messages.filter((m) => msgKeyFor(convo, m) !== key);
    state.seen.delete(key);
    if (convo.cid === state.current) renderMessages();
    renderContacts();
  };
  if (ms <= 0) remove();
  else setTimeout(remove, ms);
}
const msgKeyFor = (convo, m) => convo.type === "group" ? `g${convo.id}:${m.id}` : `d${m.id}`;

async function ingestDm(env, { live = true } = {}) {
  const key = "d" + env.id;
  if (state.seen.has(key)) return;
  const me = state.identity.username;
  const peer = env.sender === me ? env.recipient : env.sender;
  if (state.blocked.has(peer)) { state.seen.add(key); return; }
  const convo = ensureDmConvo(peer);

  let senderKeys;
  try { senderKeys = await getPeerKeys(env.sender); } catch { return; }

  const msg = await decodeEnvelope(env, senderKeys, "");
  if (msg) pushMessage(convo, msg, key, env, live);
}

async function ingestGroup(env, { live = true } = {}) {
  const key = `g${env.group_id}:${env.id}`;
  if (state.seen.has(key)) return;
  if (state.blocked.has(env.sender)) { state.seen.add(key); return; }
  let convo = state.convos[groupCid(env.group_id)];
  if (!convo) { try { convo = await ensureGroupLoaded(env.group_id); } catch { return; } }
  const ctx = "g:" + env.group_id;
  let senderKeys = (convo.meta?.members || []).find((m) => m.username === env.sender);
  if (!senderKeys) { try { senderKeys = await getPeerKeys(env.sender); } catch { return; } }

  const msg = await decodeEnvelope(env, senderKeys, ctx);
  if (msg) pushMessage(convo, msg, key, env, live);
}

async function decodeEnvelope(env, senderKeys, ctx) {
  const me = state.identity.username;
  try {
    if (env.kind === "message") {
      const { text, verified } = await C.decryptMessage(
        env.payload, me, state.identity.kem.secretKey, senderKeys.dsa_public_key, ctx);
      return { id: env.id, from: env.sender, ts: env.created_at, kind: "message", text, verified };
    }
    if (env.kind === "file") {
      const ok = C.verifyFilePayload(env.payload, senderKeys.dsa_public_key, ctx);
      return {
        id: env.id, from: env.sender, ts: env.created_at, kind: "file", verified: ok,
        file: {
          file_id: env.payload.file_id, filename: env.payload.filename,
          mime: env.payload.mime, size: env.payload.size, payload: env.payload, ctx,
        },
      };
    }
    return null;
  } catch (err) {
    return { id: env.id, from: env.sender, ts: env.created_at, kind: "error", text: err.message, verified: false };
  }
}

function onEnvelope(env, kind) {
  if (kind === "group") ingestGroup(env);
  else ingestDm(env);
}

async function onGroupEvent(msg) {
  // Membership/creation changes — refresh the affected group.
  try {
    if (msg.action === "created") {
      const g = await api.getGroup(msg.group_id);
      ensureGroupConvo(g);
      renderContacts();
    } else if (msg.action === "members") {
      const g = await api.getGroup(msg.group_id).catch(() => null);
      if (g) { ensureGroupConvo(g); if (state.current === groupCid(msg.group_id)) selectConversation(state.current); }
      else { // we were removed
        delete state.convos[groupCid(msg.group_id)];
        if (state.current === groupCid(msg.group_id)) { state.current = null; $("#conversation").hidden = true; $("#empty-state").hidden = false; }
      }
      renderContacts();
    }
  } catch (_) {}
}

function onPresence({ username, online }) {
  if (online) state.online.add(username); else state.online.delete(username);
  const c = curConvo();
  if (c && c.type === "dm" && username === c.id) {
    $("#peer-status").textContent = online ? "online" : "offline";
    $("#peer-status").className = "peer-status " + (online ? "online" : "");
  }
}

function maybeNotify(convo, msg) {
  if (localStorage.getItem(NOTIFY_KEY) !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden && convo.cid === state.current) return;
  const title = convo.type === "group" ? `👥 ${convo.meta?.name || "Group"}` : msg.from;
  const body = convo.type === "group" ? `${msg.from}: new message` : "New message";
  try { new Notification(title, { body }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Rendering messages
// ---------------------------------------------------------------------------
function renderMessages() {
  const wrap = $("#messages");
  wrap.innerHTML = "";
  const c = curConvo();
  if (!c) return;
  const me = state.identity.username;
  let lastDay = "";
  for (const m of c.messages) {
    const day = new Date(m.ts * 1000).toDateString();
    if (day !== lastDay) { wrap.append(el("div", { class: "day-sep" }, day)); lastDay = day; }
    const mine = m.from === me;
    const bubble = el("div", { class: "bubble " + (mine ? "mine" : "theirs") });
    if (c.type === "group" && !mine) bubble.append(el("div", { class: "msg-sender" }, m.from));
    if (m.kind === "file") bubble.append(renderFile(m));
    else if (m.kind === "error") bubble.append(el("div", { class: "msg-error" }, "⚠ " + m.text));
    else bubble.append(el("div", { class: "msg-text", html: escapeHtml(m.text).replace(/\n/g, "<br>") }));
    bubble.append(el("div", { class: "msg-meta" },
      m.verified ? el("span", { class: "verified", title: "Signature verified" }, "🔒")
                 : el("span", { class: "unverified", title: "Not verified" }, "⚠"),
      " ", fmtTime(m.ts)));
    wrap.append(el("div", { class: "row " + (mine ? "right" : "left") }, bubble));
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function renderFile(m) {
  return el("div", { class: "file-card" },
    el("div", { class: "file-icon" }, "📎"),
    el("div", { class: "file-info" },
      el("div", { class: "file-name" }, m.file.filename),
      el("div", { class: "file-size" }, fmtBytes(m.file.size))),
    el("button", { class: "file-dl", onclick: () => downloadFile(m) }, "Download")
  );
}

async function downloadFile(m) {
  try {
    toast("Downloading & decrypting…");
    const cipher = await api.downloadFile(m.file.file_id);
    const senderKeys = await getPeerKeys(m.from);
    const plain = await C.decryptFile(
      cipher, m.file.payload, state.identity.username,
      state.identity.kem.secretKey, senderKeys.dsa_public_key, m.file.ctx || "");
    download(m.file.filename, plain, m.file.mime || "application/octet-stream");
  } catch (err) {
    toast(err.message || "Download failed", "error");
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function recipientsFor(convo) {
  const me = state.identity.username;
  if (convo.type === "group") {
    return (convo.meta.members || []).map((m) => ({ username: m.username, kemPub: m.kem_public_key }));
  }
  const list = [{ username: convo.id, kemPub: state.peers[convo.id].kem_public_key }];
  if (convo.id !== me) list.push({ username: me, kemPub: state.identity.kem.publicKey });
  return list;
}
const ctxFor = (convo) => (convo.type === "group" ? "g:" + convo.id : "");

async function sendCurrent() {
  const c = curConvo();
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !c) return;
  try {
    if (c.type === "group") await ensureGroupLoaded(c.id);
    else await getPeerKeys(c.id);
    const payload = await C.encryptMessage(text, recipientsFor(c), state.identity.dsa.secretKey, ctxFor(c));
    input.value = ""; input.style.height = "auto";
    const ttl = getTtl(c.cid) || undefined;
    let env;
    if (c.type === "group") env = await api.sendGroupMessage(c.id, { payload, ttl });
    else env = await api.sendMessage({ recipient: c.id, payload, ttl });
    playSent();
    if (c.type === "group") await ingestGroup(env, { live: false });
    else await ingestDm(env, { live: false });
    renderMessages(); renderContacts();
  } catch (err) {
    toast(err.message || "Send failed", "error");
  }
}

async function onAttachFile(e) {
  const c = curConvo();
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !c) return;
  try {
    if (c.type === "group") await ensureGroupLoaded(c.id);
    else await getPeerKeys(c.id);
    toast(`Encrypting ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = { filename: file.name, mime: file.type || "application/octet-stream", size: bytes.length };
    const { cipherBytes, payload } = await C.encryptFile(
      bytes, meta, recipientsFor(c), state.identity.dsa.secretKey, ctxFor(c));
    const { file_id } = await api.uploadFile(cipherBytes, bytes.length);
    payload.file_id = file_id;
    const ttl = getTtl(c.cid) || undefined;
    const body = { file_id, filename: meta.filename, mime: meta.mime, size: meta.size, payload, ttl };
    let env;
    if (c.type === "group") env = await api.sendGroupFile(c.id, body);
    else env = await api.sendFileMessage({ recipient: c.id, ...body });
    playSent();
    if (c.type === "group") await ingestGroup(env, { live: false });
    else await ingestDm(env, { live: false });
    renderMessages(); renderContacts();
    toast("File sent (encrypted)", "success");
  } catch (err) {
    toast(err.message || "File send failed", "error");
  }
}

// ---------------------------------------------------------------------------
// Chat header menu (disappearing / block / group info)
// ---------------------------------------------------------------------------
function toggleChatMenu(e) {
  e.stopPropagation();
  const menu = $("#chat-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  const c = curConvo();
  if (!c) return;
  menu.innerHTML = "";
  menu.append(el("button", { onclick: () => { menu.hidden = true; openTtl(c); } }, "⏲ Disappearing messages"));
  if (c.type === "dm") {
    const blocked = state.blocked.has(c.id);
    menu.append(el("button", { class: blocked ? "" : "danger", onclick: () => { menu.hidden = true; blocked ? unblockUser(c.id) : blockUser(c.id); } },
      blocked ? "✔ Unblock user" : "🚫 Block user"));
  } else {
    menu.append(el("button", { onclick: () => { menu.hidden = true; openGroupInfo(c); } }, "👥 Group info"));
  }
  menu.hidden = false;
}

function blockUser(u) {
  state.blocked.add(u); saveBlocked();
  if (state.current === dmCid(u)) { state.current = null; $("#conversation").hidden = true; $("#empty-state").hidden = false; document.body.classList.remove("chat-open"); }
  renderContacts();
  toast(`Blocked ${u}`);
}
function unblockUser(u) {
  state.blocked.delete(u); saveBlocked();
  renderContacts();
  toast(`Unblocked ${u}`);
}

// ---------------------------------------------------------------------------
// Disappearing-messages modal
// ---------------------------------------------------------------------------
const TTL_OPTIONS = [
  { label: "Off", v: 0 }, { label: "30 sec", v: 30 }, { label: "5 min", v: 300 },
  { label: "1 hour", v: 3600 }, { label: "1 day", v: 86400 }, { label: "1 week", v: 604800 },
];
let _ttlConvo = null;
function openTtl(convo) {
  _ttlConvo = convo;
  const grid = $("#ttl-grid");
  grid.innerHTML = "";
  const cur = getTtl(convo.cid);
  for (const o of TTL_OPTIONS) {
    grid.append(el("button", { class: "ttl-opt" + (o.v === cur ? " active" : ""), onclick: () => {
      setTtlPref(convo.cid, o.v);
      $("#ttl-modal").hidden = true;
      toast(o.v ? `Disappearing messages: ${o.label}` : "Disappearing messages off");
    } }, o.label));
  }
  $("#ttl-modal").hidden = false;
}
function wireTtlModal() {
  $("#ttl-close").onclick = () => ($("#ttl-modal").hidden = true);
}

// ---------------------------------------------------------------------------
// User search modal (new DM)
// ---------------------------------------------------------------------------
function openUserSearch() {
  const modal = $("#search-modal");
  modal.hidden = false;
  const input = $("#search-input");
  input.value = ""; $("#search-results").innerHTML = ""; input.focus();
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) return ($("#search-results").innerHTML = "");
      try {
        const results = await api.searchUsers(q);
        const box = $("#search-results"); box.innerHTML = "";
        if (!results.length) { box.append(el("div", { class: "empty-hint" }, "No users found")); return; }
        for (const r of results) {
          box.append(el("div", { class: "search-item", onclick: () => {
            modal.hidden = true; ensureDmConvo(r.username); selectConversation(dmCid(r.username));
          } },
            avatarEl({ name: r.username, avatar: r.avatar }),
            el("div", {},
              el("div", { class: "contact-name" }, r.username),
              el("div", { class: "fp-mini" }, C.prettyFingerprint(r.fingerprint).slice(0, 24) + "…"))));
        }
      } catch (err) { toast(err.message, "error"); }
    }, 220);
  };
}

// ---------------------------------------------------------------------------
// Fingerprint / safety-code modal
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
  $("#fp-title").textContent = username === state.identity.username ? "Your safety code" : `Verify ${username}`;
  $("#fp-value").textContent = C.prettyFingerprint(fp);
  $("#fp-hint").textContent = username === state.identity.username
    ? "Share this with contacts so they can confirm they're talking to you."
    : "Compare this with the value shown on their device. If it matches, the channel is authentic and free of a man-in-the-middle.";
  modal.hidden = false;
}

// ---------------------------------------------------------------------------
// Groups: create + info
// ---------------------------------------------------------------------------
let _newGroupMembers = new Map(); // username -> user
function openGroupCreate() {
  _newGroupMembers = new Map();
  $("#group-name").value = ""; $("#group-icon").value = "";
  $("#group-member-search").value = "";
  $("#group-member-results").innerHTML = "";
  renderGroupChips();
  $("#group-modal").hidden = false;
  setTimeout(() => $("#group-name").focus(), 0);
}
function renderGroupChips() {
  const box = $("#group-members-chips"); box.innerHTML = "";
  for (const [u] of _newGroupMembers) {
    box.append(el("span", { class: "chip" }, u,
      el("button", { onclick: () => { _newGroupMembers.delete(u); renderGroupChips(); } }, "✕")));
  }
}
function wireGroupModals() {
  $("#group-close").onclick = () => ($("#group-modal").hidden = true);
  let timer;
  $("#group-member-search").oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = e.target.value.trim();
      const box = $("#group-member-results"); box.innerHTML = "";
      if (!q) return;
      try {
        const results = await api.searchUsers(q);
        for (const r of results) {
          box.append(el("div", { class: "search-item", onclick: () => {
            _newGroupMembers.set(r.username, r); renderGroupChips();
            $("#group-member-search").value = ""; box.innerHTML = "";
          } }, avatarEl({ name: r.username, avatar: r.avatar }),
             el("div", { class: "contact-name" }, r.username)));
        }
      } catch (_) {}
    }, 220);
  };
  $("#group-create-btn").onclick = async () => {
    const name = $("#group-name").value.trim();
    if (!name) return toast("Group needs a name", "error");
    const icon = $("#group-icon").value.trim() || null;
    try {
      const group = await api.createGroup({ name, icon, members: [..._newGroupMembers.keys()] });
      ensureGroupConvo(group);
      $("#group-modal").hidden = true;
      await selectConversation(groupCid(group.id));
      renderContacts();
      toast("Group created", "success");
    } catch (err) { toast(err.message || "Could not create group", "error"); }
  };

  $("#gi-close").onclick = () => ($("#groupinfo-modal").hidden = true);
  $("#gi-leave").onclick = async () => {
    const c = curConvo(); if (!c || c.type !== "group") return;
    if (!confirm(`Leave “${c.meta.name}”?`)) return;
    try {
      await api.removeGroupMember(c.id, state.identity.username);
      delete state.convos[groupCid(c.id)];
      state.current = null; $("#groupinfo-modal").hidden = true;
      $("#conversation").hidden = true; $("#empty-state").hidden = false;
      document.body.classList.remove("chat-open");
      renderContacts();
      toast("Left group");
    } catch (err) { toast(err.message || "Could not leave", "error"); }
  };
}

async function openGroupInfo(convo) {
  await ensureGroupLoaded(convo.id).catch(() => {});
  const g = convo.meta;
  const me = state.identity.username;
  const owner = g.owner === me;
  $("#gi-title").textContent = g.name;
  const box = $("#gi-members"); box.innerHTML = "";
  box.append(el("div", { class: "set-sub" }, `${g.members.length} members${owner ? " · you are the owner" : ""}`));
  for (const m of g.members) {
    box.append(el("div", { class: "member-row" },
      avatarEl({ name: m.username, avatar: m.avatar }),
      el("div", { class: "contact-name", style: "flex:1" }, m.username + (m.username === g.owner ? " (owner)" : "")),
      (owner && m.username !== me)
        ? el("button", { class: "btn danger", onclick: async () => {
            try { await api.removeGroupMember(g.id, m.username); await openGroupInfo(convo); } catch (err) { toast(err.message, "error"); }
          } }, "Remove") : null));
  }
  const addBox = $("#gi-add");
  addBox.hidden = !owner;
  if (owner) {
    let timer;
    $("#gi-search").value = ""; $("#gi-results").innerHTML = "";
    $("#gi-search").oninput = (e) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = e.target.value.trim(); const rbox = $("#gi-results"); rbox.innerHTML = "";
        if (!q) return;
        const results = await api.searchUsers(q).catch(() => []);
        for (const r of results) {
          rbox.append(el("div", { class: "search-item", onclick: async () => {
            try { await api.addGroupMember(g.id, r.username); await openGroupInfo(convo); } catch (err) { toast(err.message, "error"); }
          } }, avatarEl({ name: r.username, avatar: r.avatar }), el("div", { class: "contact-name" }, r.username)));
        }
      }, 220);
    };
  }
  $("#groupinfo-modal").hidden = false;
}

// ---------------------------------------------------------------------------
// Share link / QR
// ---------------------------------------------------------------------------
function myShareUrl() {
  const id = state.identity;
  return `${shareOrigin()}/#add=${encodeURIComponent(id.username)}&fp=${id.fingerprint}`;
}
function wireShareModal() {
  $("#share-close").onclick = () => ($("#share-modal").hidden = true);
  $("#share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#share-url-input").value); toast("Link copied", "success"); }
    catch { $("#share-url-input").select(); document.execCommand("copy"); toast("Link copied", "success"); }
  };
}
function openShare() {
  const url = myShareUrl();
  $("#share-url-input").value = url;
  drawQr($("#qr-canvas"), url);
  $("#share-modal").hidden = false;
}
function drawQr(canvas, text) {
  const qr = encodeText(text, ECC.MEDIUM);
  const size = qr.size;
  const quiet = 4;
  const total = size + quiet * 2;
  const scale = Math.max(2, Math.floor(canvas.width / total));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0b0b0f";
  const off = Math.floor((canvas.width - total * scale) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect(off + (x + quiet) * scale, off + (y + quiet) * scale, scale, scale);
      }
    }
  }
}

// Deep link: #add=<username>&fp=<fingerprint>
function processDeepLink() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("add=") && !hash.includes("add=")) return;
  const params = new URLSearchParams(hash);
  const who = params.get("add");
  history.replaceState(null, "", location.pathname + location.search);
  if (!who || who === state.identity.username) return;
  ensureDmConvo(who.toLowerCase());
  selectConversation(dmCid(who.toLowerCase()));
  toast(`Opening chat with ${who} — verify their safety code`, "success");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function wireSettings() {
  $("#settings-close").onclick = () => ($("#settings-modal").hidden = true);

  $$("#theme-choices .choice").forEach((btn) => {
    btn.onclick = () => { applyTheme(btn.dataset.theme); refreshSettingsUi(); };
  });
  $$("#chat-swatches .swatch").forEach((sw) => {
    sw.onclick = () => { applyChatColor(sw.dataset.c); refreshSettingsUi(); };
  });

  $("#toggle-sounds").onchange = (e) => setSounds(e.target.checked);
  $("#toggle-notify").onchange = async (e) => {
    if (e.target.checked) {
      const ok = await ensureNotifyPermission();
      if (!ok) { e.target.checked = false; toast("Notifications permission denied", "error"); return; }
      localStorage.setItem(NOTIFY_KEY, "1");
    } else localStorage.setItem(NOTIFY_KEY, "0");
  };

  $("#avatar-upload-btn").onclick = () => $("#avatar-file").click();
  $("#avatar-file").onchange = onAvatarChosen;
  $("#avatar-remove-btn").onclick = async () => {
    try { await api.setAvatar(null); state.identity.avatar = null; state.peers[state.identity.username].avatar = null; renderSelf(); refreshSettingsUi(); renderContacts(); toast("Profile image removed"); }
    catch (err) { toast(err.message, "error"); }
  };

  $("#server-save").onclick = () => { setServerUrl($("#server-url").value); location.reload(); };

  $("#export-json-btn").onclick = exportChatJson;
  $("#backup-btn").onclick = makeBackup;
  $("#restore-btn").onclick = () => $("#restore-file").click();
  $("#restore-file").onchange = onRestoreChosen;
  $("#export-vault-btn").onclick = exportVault;
  $("#delete-data-btn").onclick = deleteAppData;
}

function openSettings() { refreshSettingsUi(); $("#settings-modal").hidden = false; }

function refreshSettingsUi() {
  const theme = currentTheme(), color = currentChatColor();
  $$("#theme-choices .choice").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
  $$("#chat-swatches .swatch").forEach((s) => s.classList.toggle("active", s.dataset.c === color));
  $("#toggle-sounds").checked = soundsEnabled();
  $("#toggle-notify").checked = localStorage.getItem(NOTIFY_KEY) === "1";
  fillAvatar($("#avatar-preview"), { name: state.identity.username, avatar: state.identity.avatar });
  $("#server-section").hidden = !isExtension();
  if (isExtension()) $("#server-url").value = getServerUrl();
  renderBlockedList();
}

function renderBlockedList() {
  const box = $("#blocked-list"); box.innerHTML = "";
  if (!state.blocked.size) { box.append(el("div", { class: "set-sub" }, "You haven't blocked anyone.")); return; }
  for (const u of state.blocked) {
    box.append(el("div", { class: "blocked-item" }, u,
      el("button", { class: "btn", onclick: () => { unblockUser(u); renderBlockedList(); } }, "Unblock")));
  }
}

async function ensureNotifyPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

async function onAvatarChosen(e) {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, 256);
    await api.setAvatar(dataUrl);
    state.identity.avatar = dataUrl;
    state.peers[state.identity.username].avatar = dataUrl;
    renderSelf(); refreshSettingsUi(); renderContacts();
    toast("Profile image updated", "success");
  } catch (err) { toast(err.message || "Could not set image", "error"); }
}
async function resizeImage(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const cvs = document.createElement("canvas"); cvs.width = w; cvs.height = h;
    cvs.getContext("2d").drawImage(img, 0, 0, w, h);
    return cvs.toDataURL("image/jpeg", 0.85);
  } finally { URL.revokeObjectURL(url); }
}

// ---- exports / backups / delete ----
function serializeConvos() {
  const out = {};
  for (const cid of Object.keys(state.convos)) {
    const c = state.convos[cid];
    out[cid] = {
      type: c.type, id: c.id,
      name: c.type === "group" ? c.meta?.name : c.id,
      messages: c.messages.map((m) => ({
        id: m.id, from: m.from, ts: m.ts, kind: m.kind, text: m.text ?? null,
        file: m.file ? { filename: m.file.filename, mime: m.file.mime, size: m.file.size } : null,
        verified: m.verified,
      })),
    };
  }
  return out;
}

function exportChatJson() {
  const out = {
    app: "lattix", format: "chat-history/1", exported_at: new Date().toISOString(),
    me: state.identity.username,
    conversations: Object.values(serializeConvos()).map((c) => ({
      type: c.type, with: c.name,
      messages: c.messages.map((m) => ({
        id: m.id, from: m.from, at: new Date(m.ts * 1000).toISOString(),
        kind: m.kind, text: m.text, file: m.file, verified: m.verified,
      })),
    })),
  };
  download(`lattix-chats-${state.identity.username}.json`, JSON.stringify(out, null, 2));
  toast("Chat history exported", "success");
}

async function makeBackup() {
  const password = prompt("Choose a password to encrypt this backup:");
  if (!password) return;
  try {
    const data = {
      me: state.identity.username, convos: serializeConvos(),
      blocked: [...state.blocked],
      settings: { theme: currentTheme(), chatColor: currentChatColor() },
    };
    const sealed = await C.sealBackup(data, password);
    download(`lattix-backup-${state.identity.username}.lattixbackup.json`, JSON.stringify(sealed));
    toast("Encrypted backup saved", "success");
  } catch (err) { toast(err.message || "Backup failed", "error"); }
}

async function onRestoreChosen(e) {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  const password = prompt("Backup password:");
  if (!password) return;
  try {
    const sealed = JSON.parse(await file.text());
    const data = await C.openBackup(sealed, password);
    let restored = 0;
    for (const cid of Object.keys(data.convos || {})) {
      const src = data.convos[cid];
      const convo = src.type === "group"
        ? ensureGroupConvo({ id: src.id, name: src.name })
        : ensureDmConvo(src.id);
      for (const m of src.messages) {
        const key = msgKeyFor(convo, m);
        if (state.seen.has(key)) continue;
        state.seen.add(key);
        convo.messages.push({ ...m, file: m.file ? { ...m.file } : undefined });
        restored++;
      }
      convo.messages.sort((a, b) => a.id - b.id);
    }
    if (data.settings) { applyTheme(data.settings.theme); applyChatColor(data.settings.chatColor); }
    if (Array.isArray(data.blocked)) { data.blocked.forEach((u) => state.blocked.add(u)); saveBlocked(); }
    renderContacts();
    if (state.current) renderMessages();
    toast(`Restored ${restored} messages`, "success");
  } catch (err) { toast(err.message || "Restore failed", "error"); }
}

function exportVault() {
  const vault = loadStoredVault();
  if (!vault) return toast("No vault on this device", "error");
  download(`lattix-${state.identity.username}.vault.json`, JSON.stringify(vault, null, 2));
  toast("Encrypted vault exported. Guard it with your password.", "success");
}

async function deleteAppData() {
  if (!confirm("Delete ALL Lattix data on this device AND your account on the server? This cannot be undone.")) return;
  try { await api.deleteAccount(); } catch (_) {}
  try { await api.logout(); } catch (_) {}
  Object.keys(localStorage).filter((k) => k.startsWith("lattix.")).forEach((k) => localStorage.removeItem(k));
  toast("Lattix reset — reloading…");
  setTimeout(() => location.reload(), 600);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
initAppearance();
showAuth();
