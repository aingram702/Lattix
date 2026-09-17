// Lattix — application logic.

import { LattixApi, probeRelay } from "./api.js";
import * as C from "./crypto.js";
import {
  isExtension, getServerUrl, setServerUrl, shareOrigin, normalizeServerUrl,
  apiBase, defaultServer, serverLabel, serverOrigin, usingRemoteServer, isLocalHost,
} from "./config.js";
import {
  initAppearance, applyTheme, currentTheme, applyChatColor, currentChatColor,
} from "./theme.js";
import { playSent, playReceived, soundsEnabled, setSounds } from "./sound.js";
import { encodeText, ECC } from "./qr.js";

// Upload ceiling. The relay is the authority (LATTIX_MAX_FILE_MB); this is the
// fallback used until /api/health answers, and matches the server default.
let MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
  filter: "",            // sidebar search text
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

// Trailing punctuation is excluded so "see https://x.dev." doesn't eat the dot.
const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/g;

// Escape FIRST, then linkify the escaped text — the order matters. Anything
// the user typed is inert by the time we build anchors out of it, and the href
// carries the already-escaped form (&amp; in a URL is correct in an attribute).
// No prefetch, no link preview: fetching would leak the reader's IP and the
// fact they opened the message to whoever sent the link.
function messageHtml(text) {
  return escapeHtml(text)
    .replace(URL_RE, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`)
    .replace(/\n/g, "<br>");
}
const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// "Today" / "Yesterday" / weekday / date — used for the in-conversation separators.
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  if (d.getFullYear() === new Date().getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

// Compact stamp for the conversation list: time today, then weekday, then date.
function fmtListTime(ts) {
  const d = new Date(ts * 1000);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return fmtTime(ts);
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

// Grow the composer with its content, up to the CSS max-height.
function autosize(input) {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
function senderHue(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
function avatarColor(seed) {
  return `hsl(${senderHue(seed)} 55% 45%)`;
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

// A result row that a keyboard can actually reach and activate.
function searchItem(label, onActivate, ...children) {
  return el("div", {
    class: "search-item", role: "button", tabindex: "0", "aria-label": label,
    onclick: onActivate,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(e); } },
  }, ...children);
}

// ---------------------------------------------------------------------------
// Modal controller
//
// Every dialog in the app goes through this: it traps Tab inside the open
// dialog, closes on Escape or a backdrop click, and returns focus to whatever
// opened it. Dialogs stack, so Escape closes only the topmost one.
// ---------------------------------------------------------------------------
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let _modalStack = [];

const visibleFocusable = (root) =>
  [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);

function openModal(id, focusSel) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (!modal) return null;
  if (_modalStack.includes(modal)) return modal;
  modal._returnFocus = document.activeElement;
  modal.hidden = false;
  _modalStack.push(modal);
  const first = (focusSel && modal.querySelector(focusSel)) || visibleFocusable(modal)[0];
  setTimeout(() => { try { first?.focus(); } catch (_) {} }, 0);
  return modal;
}

function closeModal(modal) {
  modal = modal || _modalStack[_modalStack.length - 1];
  if (!modal) return;
  const wasOpen = _modalStack.includes(modal);
  modal.hidden = true;
  _modalStack = _modalStack.filter((m) => m !== modal);
  const back = modal._returnFocus;
  modal._returnFocus = null;
  // Only restore focus if the element is still in the document.
  if (back && document.contains(back)) { try { back.focus(); } catch (_) {} }
  // Lets a dialog that owns a pending promise (askModal) settle and clean up
  // when it is dismissed by Escape or a backdrop click rather than a button.
  if (wasOpen) modal.dispatchEvent(new CustomEvent("lattix:dismissed"));
}

function trapFocus(e, modal) {
  const f = visibleFocusable(modal);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

function closeChatMenu() {
  const menu = $("#chat-menu");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  $("#menu-btn")?.setAttribute("aria-expanded", "false");
  return true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const lb = $(".lightbox");
    if (lb) { lb.remove(); return; }
    if (closeChatMenu()) return;
    if (_modalStack.length) { e.preventDefault(); closeModal(); }
    return;
  }
  if (e.key === "Tab" && _modalStack.length) {
    trapFocus(e, _modalStack[_modalStack.length - 1]);
  }
});

// The .modal element is itself the scrim, so a mousedown landing on it (rather
// than on .modal-card) is a click outside the dialog.
document.addEventListener("mousedown", (e) => {
  if (e.target.classList?.contains("modal")) closeModal(e.target);
});

// ---------------------------------------------------------------------------
// askModal — a promise-based replacement for window.confirm / window.prompt.
//
// The natives are unstyled, can be suppressed by the browser, block the whole
// page, and — for prompt() — show a password in clear text with no way to
// confirm it. This builds the same dialogs out of the app's own components,
// on the modal controller above (so Escape, focus trap and focus return all
// come for free).
//
// Resolves to: the entered string (when `input` is given), `true` for a plain
// confirmation, or `null` if the user cancelled.
// ---------------------------------------------------------------------------
let _askSeq = 0;

function askModal({
  title,
  body = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  input = null,        // { type, label, placeholder, confirmLabel, minLength }
  requireText = null,  // user must type this exact string to proceed
}) {
  return new Promise((resolve) => {
    const uid = "ask-" + (++_askSeq);
    const titleId = uid + "-title";

    const field1 = input
      ? el("input", { type: input.type || "text", placeholder: input.placeholder || "",
                      autocomplete: "off", id: uid + "-f1" })
      : null;
    const field2 = input && input.confirmLabel
      ? el("input", { type: input.type || "text", placeholder: input.confirmLabel,
                      autocomplete: "off", id: uid + "-f2" })
      : null;
    const guard = requireText
      ? el("input", { type: "text", placeholder: requireText, autocomplete: "off",
                      autocapitalize: "none", spellcheck: "false", id: uid + "-g" })
      : null;

    const err = el("p", { class: "fine err", role: "alert" });
    const okBtn = el("button", { type: "submit", class: danger ? "btn danger" : "primary" }, confirmText);
    const cancelBtn = el("button", { type: "button", class: "btn" }, cancelText);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal(modal);
      modal.remove();
      resolve(value);
    };

    const submit = (e) => {
      e?.preventDefault();
      if (guard && guard.value.trim() !== requireText) {
        err.textContent = `Type “${requireText}” exactly to confirm.`;
        guard.focus();
        return;
      }
      if (field1) {
        if (!field1.value) { err.textContent = "This field is required."; field1.focus(); return; }
        if (input.minLength && field1.value.length < input.minLength) {
          err.textContent = `Must be at least ${input.minLength} characters.`;
          field1.focus();
          return;
        }
        if (field2 && field1.value !== field2.value) {
          err.textContent = "The two entries don't match.";
          field2.focus();
          return;
        }
      }
      finish(field1 ? field1.value : true);
    };

    cancelBtn.onclick = () => finish(null);

    const form = el("form", { autocomplete: "off", onsubmit: submit },
      body ? el("p", { class: "fine" }, body) : null,
      input ? el("label", { class: "stacked", for: field1.id }, input.label, field1) : null,
      field2 ? el("label", { class: "stacked", for: field2.id }, input.confirmLabel, field2) : null,
      guard ? el("label", { class: "stacked", for: guard.id }, `Type ${requireText} to confirm`, guard) : null,
      err,
      el("div", { class: "set-actions end spaced" }, cancelBtn, okBtn));

    const card = el("div", { class: "modal-card" },
      el("div", { class: "modal-head" },
        el("h3", { id: titleId }, title),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Close",
                       onclick: () => finish(null) }, "✕")),
      form);

    const modal = el("div", {
      id: uid, class: "modal", role: "dialog", "aria-modal": "true",
      "aria-labelledby": titleId, hidden: "",
    }, card);

    document.body.append(modal);
    // Escape / backdrop go through the controller, which only hides the node —
    // watch for that so the promise still settles and the node is cleaned up.
    modal.addEventListener("lattix:dismissed", () => finish(null));
    openModal(modal, input || guard ? "input" : "button.btn");
  });
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

// Drafts survive switching conversations and reloading the tab. They are
// plaintext in localStorage, same as any unsent text in a textarea, and are
// cleared on send and by "Delete application data" (which wipes lattix.*).
const draftKey = (cid) => `lattix.draft.${cid}`;
const getDraft = (cid) => localStorage.getItem(draftKey(cid)) || "";
function setDraft(cid, text) {
  if (!cid) return;
  if (text && text.trim()) localStorage.setItem(draftKey(cid), text);
  else localStorage.removeItem(draftKey(cid));
}

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
  wireAuthHelpers();
  $("#auth-relay-change").onclick = () => openServerModal();
  refreshAuthRelay();

  switchAuthView(loadStoredVault() ? "unlock" : "create");
}

// The sign-in screen names the relay it will use and whether it answers, so
// a wrong or unreachable server is obvious before keys are generated or a
// password is typed — and it can be changed right there, before any login.
let _authProbe = 0;
async function refreshAuthRelay() {
  const probe = ++_authProbe;
  const dot = $("#auth-relay-dot"), stateEl = $("#auth-relay-state");
  $("#auth-relay-host").textContent = usingRemoteServer() ? serverLabel() : "this server";
  $("#auth-relay").title = serverOrigin();
  dot.className = "conn-dot checking";
  stateEl.textContent = "checking…";
  const r = await probeRelay(apiBase(), { checkSocket: false, timeoutMs: 6000 });
  if (probe !== _authProbe) return;
  dot.className = "conn-dot " + (r.ok ? "on" : "off");
  stateEl.textContent = r.ok ? `· online${r.latencyMs ? ` (${r.latencyMs} ms)` : ""}` : "· unreachable";
  $("#auth-relay").title = r.ok ? serverOrigin() : `${serverOrigin()} — ${r.error}`;
}

// Fail fast before seconds of key generation / vault decryption when the
// relay can't be reached, and point at the setting that fixes it.
async function ensureRelayReachable() {
  const r = await probeRelay(apiBase(), { checkSocket: false, timeoutMs: 8000 });
  if (r.ok) return true;
  const change = await askModal({
    title: "Can't reach the relay",
    body: r.error,
    confirmText: "Relay settings", cancelText: "Close",
  });
  if (change) openServerModal();
  refreshAuthRelay();
  return false;
}

// A rough, local strength signal — no wordlist, no network. Length dominates
// because it should: a long passphrase beats a short scramble.
function scorePassword(pw) {
  if (pw.length < 8) return 0;
  let s = 1;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
const PW_LABEL = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

function wireAuthHelpers() {
  const pw = $("#create-password");
  const pw2 = $("#create-password2");

  pw.addEventListener("input", () => {
    const s = scorePassword(pw.value);
    $("#pw-meter").className = "pw-meter s" + s;
    $("#pw-hint").textContent = pw.value
      ? `${PW_LABEL[s]} — four or more unrelated words is easy to remember and hard to guess.`
      : "";
  });

  // Caps Lock is the classic cause of "my password stopped working".
  const capsWarn = $("#caps-warn");
  for (const node of [pw, pw2, $("#unlock-password"), $("#import-password")]) {
    if (!node) continue;
    const check = (e) => {
      const on = typeof e.getModifierState === "function" && e.getModifierState("CapsLock");
      capsWarn.hidden = !on;
    };
    node.addEventListener("keyup", check);
    node.addEventListener("keydown", check);
    node.addEventListener("blur", () => { capsWarn.hidden = true; });
  }
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
  const password2 = $("#create-password2").value;

  // Validate before generating keys: ML-KEM + ML-DSA keygen plus a 250k-round
  // PBKDF2 seal is seconds of work, and there is no point spending it on a
  // password the user has already mistyped.
  if (password.length < 8) return toast("Password must be at least 8 characters", "error");
  if (password !== password2) {
    $("#create-password2").focus();
    return toast("The two passwords don't match", "error");
  }
  if (!$("#create-ack").checked) {
    return toast("Please confirm you understand the password cannot be recovered", "error");
  }

  // Creating an account overwrites whatever vault this device already holds.
  // That vault is the only copy of an identity's private keys.
  if (loadStoredVault()) {
    const proceed = await askModal({
      title: "Replace the vault on this device?",
      body: "This device already holds an encrypted vault. Creating a new account overwrites it, and the " +
            "old identity's keys are gone unless you exported the vault file first.",
      confirmText: "Replace vault", danger: true,
    });
    if (!proceed) return;
  }

  btn.disabled = true;
  btn.classList.add("busy");
  try {
    if (!(await ensureRelayReachable())) return;
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
    // A vault that exists only in one browser's localStorage is one cache
    // clear away from gone. Offer the export while it's still on their mind.
    offerVaultBackup();
  } catch (err) {
    toast(err.message || "Registration failed", "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

async function offerVaultBackup() {
  const ok = await askModal({
    title: "Back up your vault now",
    body: "Your private keys live only in this browser. Export the encrypted vault file and keep it " +
          "somewhere safe — it is the only way to restore this identity on another device, or after " +
          "clearing site data.",
    confirmText: "Export vault", cancelText: "Later",
  });
  if (ok) exportVault();
}

async function onUnlock(e) {
  e.preventDefault();
  const btn = $("#unlock-form button[type=submit]");
  const password = $("#unlock-password").value;
  const vault = loadStoredVault();
  if (!vault) return switchAuthView("create");
  btn.disabled = true; btn.classList.add("busy");
  try {
    if (!(await ensureRelayReachable())) return;
    const identity = await C.openVault(vault, password);
    if (!(await loginOrEnroll(identity))) return;
    await bootApp(identity);
  } catch (err) {
    toast(err.message || "Unlock failed", "error");
  } finally {
    btn.disabled = false; btn.classList.remove("busy");
  }
}

// Log in with an unlocked identity. The vault has already decrypted, so the
// password is right; a 401 here means THIS relay doesn't know the identity —
// typically because the user just pointed Lattix at a new relay (say, their
// own VPS). Offer to publish the same keys there instead of a dead end.
async function loginOrEnroll(identity) {
  try {
    await api.login(identity.username, identity.authSecret);
    return true;
  } catch (err) {
    if (err.status !== 401) throw err;
  }
  const label = serverLabel();
  const enroll = await askModal({
    title: `${identity.username} isn't registered on ${label}`,
    body: `Your vault unlocked, but this relay doesn't recognise the account. If you've moved to a new ` +
          `relay, you can register this same identity here — your keys and safety code stay the same, but ` +
          `conversations on the old relay don't come with it, and contacts need to use this relay too.`,
    confirmText: "Register here", cancelText: "Cancel",
  });
  if (!enroll) return false;
  try {
    await api.register({
      username: identity.username,
      kem_public_key: identity.kem.publicKey,
      dsa_public_key: identity.dsa.publicKey,
      fingerprint: identity.fingerprint,
      auth_secret: identity.authSecret,
    });
  } catch (err) {
    if (err.status === 409) {
      throw new Error(`The username "${identity.username}" is already taken on ${label} by a different identity.`);
    }
    throw err;
  }
  toast(`Registered ${identity.username} on ${label}`, "success");
  return true;
}

async function onImport(e) {
  e.preventDefault();
  const btn = $("#import-form button[type=submit]");
  const file = $("#import-file").files[0];
  const password = $("#import-password").value;
  if (!file) return toast("Choose a vault file", "error");
  btn.disabled = true; btn.classList.add("busy");
  try {
    const vault = JSON.parse(await file.text());
    if (!(await ensureRelayReachable())) return;
    const identity = await C.openVault(vault, password);
    if (!(await loginOrEnroll(identity))) return;
    storeVault(vault);
    await bootApp(identity);
    toast("Vault imported to this device", "success");
  } catch (err) {
    toast(err.message || "Import failed", "error");
  } finally {
    btn.disabled = false; btn.classList.remove("busy");
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

  // The relay keeps sessions in memory, so restarting it (a deploy, a VPS
  // reboot) or letting the 12-hour token lapse would otherwise strand this
  // tab. The identity is already unlocked, so just log in again.
  api.setReauth(() => api.login(identity.username, identity.authSecret));

  api.on("envelope", (env) => onEnvelope(env, "dm"))
     .on("group_envelope", (env) => onEnvelope(env, "group"))
     .on("group", onGroupEvent)
     .on("presence", onPresence)
     .on("status", (s) => {
       setConnected(s.connected);
       if (s.connected && s.reconnected) resyncAfterReconnect();
     })
     .on("auth", (a) => { if (!a.renewed) onSessionRejected(); });

  // Learn this relay's upload ceiling and capabilities before opening the
  // socket (the socket's auth mode depends on them); harmless if an older
  // relay omits either.
  await api.health()
    .then((h) => { if (h && h.max_file_bytes > 0) MAX_UPLOAD_BYTES = h.max_file_bytes; })
    .catch(() => {});
  api.connectSocket();

  const me = await api.me();
  identity.avatar = me.avatar || identity.avatar || null;
  state.peers[identity.username].avatar = identity.avatar;
  renderSelf();

  for (const c of me.contacts) ensureDmConvo(c);
  for (const g of (me.groups || [])) ensureGroupConvo(g);
  restoreDraftedConvos();
  renderContacts();

  // Load every conversation's history concurrently. Serially awaiting each
  // one meant boot time scaled with the number of contacts times the round
  // trip; allSettled means one slow or failing conversation doesn't hold up
  // the rest, or abort the boot.
  await Promise.allSettled([
    ...me.contacts.map((c) => loadDm(c, { live: false })),
    ...(me.groups || []).map((g) => loadGroup(g.id, { live: false })),
  ]);
  renderContacts();

  processDeepLink();

  // One periodic sweep handles every disappearing message in every
  // conversation, however much history is loaded.
  sweepExpired();
  setInterval(sweepExpired, EXPIRY_SWEEP_MS);
  document.addEventListener("visibilitychange", () => {
    // Timers are throttled in a background tab, so catch up on return.
    if (!document.hidden) sweepExpired();
  });
}

// The relay derives your contact list from envelopes, so a conversation you
// only ever typed a draft into has no server-side record and would not come
// back after a reload — leaving the draft stranded in localStorage, invisible
// and unreachable. Rebuild those rows from the stored drafts.
function restoreDraftedConvos() {
  const prefix = "lattix.draft.";
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const cid = key.slice(prefix.length);
    if (!localStorage.getItem(key)?.trim()) { localStorage.removeItem(key); continue; }
    if (state.convos[cid]) continue;
    // Groups always come back via /api/me; a stale group draft has no metadata
    // to rebuild from, so drop it rather than inventing an empty group.
    if (isGroupCid(cid)) { localStorage.removeItem(key); continue; }
    if (cid === state.identity.username || state.blocked.has(cid)) continue;
    ensureDmConvo(cid);
  }
}

function renderSelf() {
  const id = state.identity;
  $("#self-name").textContent = id.username;
  fillAvatar($("#self-avatar"), { name: id.username, avatar: id.avatar });
  $("#self-avatar").classList.add("lg");
  $("#self-fingerprint").textContent = C.prettyFingerprint(id.fingerprint).slice(0, 29) + "…";
}

function setConnected(v) {
  const was = state.connected;
  state.connected = v;
  $("#conn-dot").className = "conn-dot " + (v ? "on" : "off");
  $("#conn-label").textContent = v
    ? (usingRemoteServer() ? `Connected · ${serverLabel()}` : "Connected")
    : "Reconnecting…";
  const strip = $("#conn-status");
  strip.classList.toggle("clickable", !v);
  strip.setAttribute("title", v ? `Connected to the relay at ${serverOrigin()}` : "Disconnected — click to retry now");
  // Presence is re-sent as a snapshot on every connect; anything we believed
  // while disconnected is stale (contacts may have left in the meantime).
  if (v && !was && state.online.size) { state.online.clear(); scheduleContacts(); }
}

// Envelopes pushed while the socket was down were never delivered to this
// tab. After a reconnect, pull everything newer than what we hold — new
// contacts and groups included — so a proxy hiccup or a relay restart never
// silently loses messages.
let _resync = null;
function resyncAfterReconnect() {
  if (_resync) return _resync;
  _resync = (async () => {
    try {
      const me = await api.me();
      for (const c of me.contacts) ensureDmConvo(c);
      for (const g of (me.groups || [])) ensureGroupConvo(g);
      await Promise.allSettled([
        ...me.contacts.map(async (c) => {
          const convo = ensureDmConvo(c);
          const envs = await api.conversation(c, convo.maxId);
          for (const env of envs) await ingestDm(env, { live: true });
        }),
        ...(me.groups || []).map(async (g) => {
          const convo = ensureGroupConvo(g);
          const envs = await api.groupMessages(g.id, convo.maxId);
          for (const env of envs) await ingestGroup(env, { live: true });
        }),
      ]);
      renderContacts();
    } catch (_) {
      // Next reconnect tries again.
    } finally {
      _resync = null;
    }
  })();
  return _resync;
}

// The relay refused to renew the session: the account was deleted, or its
// credentials no longer match (e.g. a different relay now answers at this
// address). Keys stay safe in the vault; send the user back to unlock.
let _sessionRejected = false;
function onSessionRejected() {
  if (_sessionRejected) return;
  _sessionRejected = true;
  askModal({
    title: "Signed out by the relay",
    body: `${serverLabel()} no longer accepts this session and rejected signing in again. Your keys are still ` +
          `in this device's vault — unlock to try again, or check Relay server settings.`,
    confirmText: "Back to sign-in", cancelText: "Relay settings",
  }).then((back) => {
    if (back) location.reload();
    else openServerModal({ afterClose: () => location.reload() });
  });
}

// ---------------------------------------------------------------------------
// App-level event wiring (bound once)
// ---------------------------------------------------------------------------
function wireAppEvents() {
  $("#logout-btn").onclick = async () => { await api.logout(); location.reload(); };
  $("#settings-btn").onclick = openSettings;
  $("#share-btn").onclick = openShare;

  $("#back-btn").onclick = () => {
    // Mobile's main way out of a conversation — stash the draft on the way.
    setDraft(state.current, $("#msg-input").value);
    document.body.classList.remove("chat-open");
    state.current = null;
    renderContacts();
  };

  $("#conn-status").onclick = () => {
    if (state.connected) return;
    api.reconnectNow();
    toast("Reconnecting…");
  };

  $("#contact-filter").oninput = (e) => {
    state.filter = e.target.value;
    renderContacts();
  };
  // Escape clears the filter rather than closing anything.
  $("#contact-filter").onkeydown = (e) => {
    if (e.key === "Escape" && e.target.value) {
      e.stopPropagation();
      e.target.value = "";
      state.filter = "";
      renderContacts();
    }
  };

  $("#new-chat-btn").onclick = () => openUserSearch();
  $("#new-group-btn").onclick = () => openGroupCreate();
  $("#empty-new-chat").onclick = () => openUserSearch();
  $("#empty-share").onclick = () => openShare();
  $("#search-close").onclick = () => closeModal($("#search-modal"));
  $("#fp-close").onclick = () => closeModal($("#fp-modal"));

  const input = $("#msg-input");
  // On a phone the on-screen Return key should insert a newline — there is a
  // send button right there. Only treat Enter as "send" where there's a real
  // keyboard.
  const hasPointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && hasPointer) { e.preventDefault(); sendCurrent(); }
  });
  let draftTimer;
  input.addEventListener("input", () => {
    autosize(input);
    $("#send-btn").disabled = !input.value.trim() || _composerBusy;
    // Debounced so a fast typist isn't writing to localStorage per keystroke.
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const cid = state.current;
      if (!cid) return;
      const had = !!getDraft(cid);
      setDraft(cid, input.value);
      // Only repaint the list when the marker actually appears or disappears.
      if (had !== !!input.value.trim()) renderContacts();
    }, 400);
  });
  // Don't lose a draft to a reload or a closed tab.
  window.addEventListener("beforeunload", () => setDraft(state.current, input.value));
  $("#send-btn").disabled = true;
  $("#send-btn").onclick = sendCurrent;

  // Keep the view pinned to the newest message only when the reader is already
  // there; otherwise offer an explicit jump.
  $("#jump-latest").onclick = () => {
    const wrap = $("#messages");
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: "smooth" });
    hideJumpPill();
  };
  $("#messages").addEventListener("scroll", () => {
    const wrap = $("#messages");
    if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80) hideJumpPill();
  });
  $("#attach-btn").onclick = () => $("#file-input").click();
  $("#file-input").onchange = onAttachFile;

  // Drop a file anywhere on the open conversation. dragenter/dragleave fire
  // for every child element, so count depth rather than toggling on each.
  const dz = $("#conversation");
  let dragDepth = 0;
  const endDrag = () => { dragDepth = 0; dz.classList.remove("dropping"); };
  dz.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    if (++dragDepth === 1) dz.classList.add("dropping");
  });
  dz.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  dz.addEventListener("dragleave", () => { if (--dragDepth <= 0) endDrag(); });
  dz.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    endDrag();
    const f = e.dataTransfer.files?.[0];
    if (f) sendFile(f);
  });

  // Paste an image straight into the composer.
  input.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file");
    if (!item) return;                       // ordinary text paste
    const f = item.getAsFile();
    if (!f) return;
    e.preventDefault();
    sendFile(f);
  });
  $("#verify-peer-btn").onclick = () => {
    const c = curConvo();
    if (c && c.type === "dm") openFingerprint(c.id);
    else if (c) openGroupInfo(c);
  };
  $("#menu-btn").onclick = toggleChatMenu;
  document.addEventListener("click", (e) => {
    if (!$("#chat-menu").hidden && !e.target.closest(".header-actions")) closeChatMenu();
  });

  wireSettings();
  wireGroupModals();
  wireShareModal();
  wireTtlModal();
  wireShortcuts();
}

// Global keyboard shortcuts. Deliberately few, and all inert while a dialog is
// open so they can't fire from inside one.
function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (_modalStack.length) return;
    if ($("#app-screen").hidden) return;
    const focused = document.activeElement;
    const typing = /^(INPUT|TEXTAREA)$/.test(focused?.tagName || "");
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openUserSearch(); return; }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("#contact-filter")?.focus(); return; }
    if (e.key === "/" && !typing) { e.preventDefault(); $("#msg-input")?.focus(); return; }
    if (e.key === "Escape" && typing && focused.id === "msg-input" && !focused.value) focused.blur();
  });
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
// Unread total in the tab title, so a backgrounded Lattix still says something.
const BASE_TITLE = "Lattix — quantum-resistant messaging";
function updateUnreadTitle() {
  const total = Object.values(state.convos)
    .filter((c) => !(c.type === "dm" && state.blocked.has(c.cid)))
    .reduce((n, c) => n + (c.unread || 0), 0);
  document.title = total ? `(${total}) Lattix` : BASE_TITLE;
}

// Does this conversation match the sidebar filter? Matches the name, and the
// text of any message already decrypted on this device (the relay can't search
// — it only ever holds ciphertext).
function matchesFilter(c, q) {
  if (!q) return true;
  const name = (c.type === "group" ? c.meta?.name || "" : c.id).toLowerCase();
  if (name.includes(q)) return true;
  return c.messages.some((m) =>
    (m.text || "").toLowerCase().includes(q) ||
    (m.file?.filename || "").toLowerCase().includes(q));
}

function renderContacts() {
  const list = $("#contacts");
  list.innerHTML = "";
  const q = (state.filter || "").trim().toLowerCase();
  const all = Object.keys(state.convos)
    .filter((cid) => !(state.convos[cid].type === "dm" && state.blocked.has(cid)));
  const cids = all
    .filter((cid) => matchesFilter(state.convos[cid], q))
    .sort((a, b) => lastTs(b) - lastTs(a));

  if (cids.length === 0) {
    list.append(el("div", { class: "empty-hint" },
      q ? `No conversations match “${state.filter.trim()}”`
        : "No conversations yet. Start a chat or group."));
    updateUnreadTitle();
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
    // state.online is already maintained from the presence event; surface it
    // in the list, not just in the open conversation's header.
    const online = c.type === "dm" && state.online.has(c.id);
    if (online) avatar.append(el("span", { class: "presence-dot", title: "Online" }));
    // The live composer wins over the stored value for the open conversation,
    // so the marker tracks typing without waiting for the debounce.
    const draft = cid === state.current ? $("#msg-input").value.trim() : getDraft(cid).trim();
    const open = () => selectConversation(cid);
    const item = el("div", {
      class: "contact" + (cid === state.current ? " active" : ""),
      role: "button", tabindex: "0",
      "aria-current": cid === state.current ? "true" : null,
      "aria-label": `${c.type === "group" ? "Group " : ""}${name}` +
        `${online ? ", online" : ""}${c.unread ? `, ${c.unread} unread` : ""}`,
      onclick: open,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
    },
      avatar,
      el("div", { class: "contact-main" },
        el("div", { class: "contact-top" },
          el("span", { class: "contact-name" }, (c.type === "group" ? "👥 " : "") + name),
          el("span", { class: "contact-time" }, last ? fmtListTime(last.ts) : "")),
        // An unsent draft outranks the last message in the preview slot —
        // it's the thing the user still has to act on.
        draft
          ? el("div", { class: "contact-preview draft" }, "✏️ " + draft)
          : el("div", { class: "contact-preview" }, preview)),
      c.unread ? el("span", { class: "badge" }, String(c.unread)) : null
    );
    list.append(item);
  }
  updateUnreadTitle();
}

async function selectConversation(cid) {
  // Stash whatever was being typed in the conversation we're leaving, and
  // load whatever was left in the one we're entering.
  const leaving = state.current;
  if (leaving && leaving !== cid) setDraft(leaving, $("#msg-input").value);

  state.current = cid;
  const c = state.convos[cid];
  c.unread = 0;

  if (leaving !== cid) {
    const input = $("#msg-input");
    input.value = getDraft(cid);
    autosize(input);
    $("#send-btn").disabled = !input.value.trim();
  }
  $("#empty-state").hidden = true;
  $("#conversation").hidden = false;
  document.body.classList.add("chat-open");
  closeChatMenu();

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
  renderMessages({ force: true });
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

  const mine = msg.from === state.identity.username;
  if (live && !mine) {
    if (convo.cid !== state.current) convo.unread++;
    playReceived();
    maybeNotify(convo, msg);
  }
  if (convo.cid === state.current) scheduleMessages();
  scheduleContacts();
  // An already-expired message (fetched after its deadline) goes at once;
  // everything else is handled by the sweep below.
  if (msg.expires_at && msg.expires_at * 1000 <= Date.now()) sweepExpired();
}

// Disappearing messages used to register a setTimeout per message at ingest
// time, so every reload re-armed one timer for every message in history. One
// periodic sweep costs the same regardless of how much history is loaded, and
// survives the tab being backgrounded (where timers are throttled).
const EXPIRY_SWEEP_MS = 15000;

function sweepExpired() {
  const now = Date.now() / 1000;
  let touchedCurrent = false, touchedAny = false;
  for (const convo of Object.values(state.convos)) {
    const expired = convo.messages.filter((m) => m.expires_at && m.expires_at <= now);
    if (!expired.length) continue;
    releaseObjectUrls(expired);
    for (const m of expired) state.seen.delete(msgKeyFor(convo, m));
    convo.messages = convo.messages.filter((m) => !(m.expires_at && m.expires_at <= now));
    touchedAny = true;
    if (convo.cid === state.current) touchedCurrent = true;
  }
  if (touchedCurrent) scheduleMessages();
  if (touchedAny) scheduleContacts();
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
  // Carried onto every message so the expiry sweep can find them without a
  // per-message timer.
  const expires_at = env.expires_at || null;
  try {
    if (env.kind === "message") {
      const { text, verified } = await C.decryptMessage(
        env.payload, me, state.identity.kem.secretKey, senderKeys.dsa_public_key, ctx);
      return { id: env.id, from: env.sender, ts: env.created_at, kind: "message", text, verified, expires_at };
    }
    if (env.kind === "file") {
      const ok = C.verifyFilePayload(env.payload, senderKeys.dsa_public_key, ctx);
      return {
        id: env.id, from: env.sender, ts: env.created_at, kind: "file", verified: ok, expires_at,
        file: {
          file_id: env.payload.file_id, filename: env.payload.filename,
          mime: env.payload.mime, size: env.payload.size, payload: env.payload, ctx,
        },
      };
    }
    return null;
  } catch (err) {
    return { id: env.id, from: env.sender, ts: env.created_at, kind: "error", text: err.message, verified: false, expires_at };
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
  // Keep the sidebar dots live too.
  if (state.convos[dmCid(username)]) scheduleContacts();
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
// ---------------------------------------------------------------------------
// Render scheduling
//
// Both renders rebuild their container from scratch. Ingesting an envelope
// used to call each of them directly, so a burst of N messages — a boot that
// replays history, or a peer sending quickly — meant N full rebuilds. Coalesce
// into one pass per frame instead. `force` on messages is sticky: if any
// pending request wanted the view pinned to the newest message, the coalesced
// render honours that.
// ---------------------------------------------------------------------------
const _pendingRender = { msgs: false, contacts: false, force: false };

function scheduleMessages({ force = false } = {}) {
  _pendingRender.force = _pendingRender.force || force;
  if (_pendingRender.msgs) return;
  _pendingRender.msgs = true;
  requestAnimationFrame(() => {
    _pendingRender.msgs = false;
    const f = _pendingRender.force;
    _pendingRender.force = false;
    if (curConvo()) renderMessages({ force: f });
  });
}

function scheduleContacts() {
  if (_pendingRender.contacts) return;
  _pendingRender.contacts = true;
  requestAnimationFrame(() => {
    _pendingRender.contacts = false;
    renderContacts();
  });
}

const showJumpPill = () => ($("#jump-latest").hidden = false);
const hideJumpPill = () => ($("#jump-latest").hidden = true);
// Message count at the previous render, per conversation — lets us tell "the
// list grew while you were reading history" from "the list was just redrawn".
const _renderedCount = {};

// Only the newest slice of a long conversation is in the DOM at any time —
// rebuilding thousands of bubbles on every render is what makes a busy chat
// feel slow. Nothing is dropped from state; "load earlier" widens the slice.
const RENDER_WINDOW = 200;
const _windowFor = {};
const windowSize = (cid) => _windowFor[cid] || RENDER_WINDOW;

function renderMessages({ force = false } = {}) {
  const wrap = $("#messages");
  // Measure before we blow the list away.
  const wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

  wrap.innerHTML = "";
  const c = curConvo();
  if (!c) { hideJumpPill(); return; }
  const me = state.identity.username;

  const size = windowSize(c.cid);
  const hidden = Math.max(0, c.messages.length - size);
  const shown = hidden ? c.messages.slice(-size) : c.messages;
  if (hidden) {
    wrap.append(el("button", {
      class: "load-earlier",
      onclick: () => {
        // Keep the reader's place: note the distance from the bottom, then
        // restore it once the taller list has rendered.
        const fromBottom = wrap.scrollHeight - wrap.scrollTop;
        _windowFor[c.cid] = size + RENDER_WINDOW;
        renderMessages({ force: false });
        wrap.scrollTop = wrap.scrollHeight - fromBottom;
      },
    }, `Load earlier messages (${hidden} more)`));
  }

  let lastDay = "";
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const prev = i > 0 ? shown[i - 1] : null;
    const day = dayLabel(m.ts);
    const newDay = day !== lastDay;
    if (newDay) { wrap.append(el("div", { class: "day-sep" }, day)); lastDay = day; }
    const mine = m.from === me;
    // True when this message continues an unbroken run from the same sender.
    // Phase 1 uses this to collapse spacing and hide the repeated sender label.
    const sameRun = !!prev && !newDay && prev.from === m.from &&
                    prev.kind !== "error" && m.kind !== "error" &&
                    (m.ts - prev.ts) < 300;
    // A signature that failed to verify is the loudest thing this app can say.
    const failed = m.verified === false && m.kind !== "error";
    const bubble = el("div", {
      class: "bubble " + (mine ? "mine" : "theirs") +
             (failed ? " unverified-msg" : "") + (sameRun ? " same" : ""),
    });
    // Colour the sender label by name so a busy group stays scannable. The
    // lightness comes from the theme so it stays readable on light and dark.
    if (c.type === "group" && !mine) {
      bubble.append(el("div", {
        class: "msg-sender",
        style: `color: hsl(${senderHue(m.from)} 62% var(--sender-l))`,
      }, m.from));
    }
    if (m.kind === "file") {
      bubble.append(renderFile(m));
      // Constrain the bubble to the preview, not to its widest flex line.
      if (bubble.querySelector(".img-card")) bubble.classList.add("has-image");
    }
    else if (m.kind === "error") bubble.append(el("div", { class: "msg-error" }, "⚠ " + m.text));
    else bubble.append(el("div", { class: "msg-text", html: messageHtml(m.text) }));
    bubble.append(el("div", { class: "msg-meta" },
      m.verified ? el("span", { class: "verified", title: "Signature verified" }, "🔒")
                 : el("span", { class: "unverified", title: "Signature could not be verified" }, "⚠"),
      " ", fmtTime(m.ts)));
    const row = el("div", {
      class: "row " + (mine ? "right" : "left") + (sameRun ? " same" : ""),
    });
    // In groups, incoming messages get an avatar outside the bubble. Within a
    // run the slot is kept but hidden, so bubbles stay aligned.
    if (c.type === "group" && !mine) {
      row.append(avatarEl(
        { name: m.from, avatar: state.peers[m.from]?.avatar },
        "msg-avatar" + (sameRun ? " spacer" : "")));
    }
    row.append(bubble);
    if (m.kind === "message") row.append(messageActions(m));
    wrap.append(row);
  }

  const grew = c.messages.length > (_renderedCount[c.cid] ?? 0);
  _renderedCount[c.cid] = c.messages.length;

  if (force || wasAtBottom) {
    wrap.scrollTop = wrap.scrollHeight;
    hideJumpPill();
  } else if (grew) {
    showJumpPill();
  }
}

// Raster formats only — SVG is scriptable and is never previewed inline.
const PREVIEW_MIME = /^image\/(png|jpeg|gif|webp|avif)$/i;
const PREVIEW_MAX = 8 * 1024 * 1024;
const AUTOIMG_KEY = "lattix.autoImages";
const autoImages = () => localStorage.getItem(AUTOIMG_KEY) !== "0";

// Copy and quote are purely local — neither touches the envelope format, so
// they work against the existing protocol. A true threaded reply needs a
// versioned plaintext body; see docs/phase-1-brief.md.
function messageActions(m) {
  const quote = () => {
    const input = $("#msg-input");
    const quoted = m.text.split("\n").map((l) => "> " + l).join("\n");
    input.value = quoted + "\n\n" + input.value;
    autosize(input);
    $("#send-btn").disabled = !input.value.trim();
    input.focus();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(m.text); toast("Copied"); }
    catch { toast("Could not copy", "error"); }
  };
  return el("div", { class: "msg-actions" },
    el("button", { class: "msg-act", title: "Copy", "aria-label": "Copy message", onclick: copy }, "⧉"),
    el("button", { class: "msg-act", title: "Quote", "aria-label": "Quote message", onclick: quote }, "↩"));
}

function renderFile(m) {
  // Only ever preview media whose ML-DSA signature verified. A forged or
  // tampered envelope stays an inert file card the reader must opt into.
  const previewable =
    m.verified === true &&
    PREVIEW_MIME.test(m.file.mime || "") &&
    m.file.size <= PREVIEW_MAX;

  if (previewable) {
    const holder = el("div", { class: "img-card" });
    if (autoImages()) {
      revealImage(m, holder);
    } else {
      holder.append(
        el("div", { class: "img-placeholder" }, "🖼 " + m.file.filename),
        el("button", { class: "file-dl", onclick: () => revealImage(m, holder) }, "Show image"));
    }
    return holder;
  }

  return el("div", { class: "file-card" },
    el("div", { class: "file-icon" }, "📎"),
    el("div", { class: "file-info" },
      el("div", { class: "file-name" }, m.file.filename),
      el("div", { class: "file-size" }, fmtBytes(m.file.size))),
    el("button", { class: "file-dl", onclick: () => downloadFile(m) }, "Download")
  );
}

async function revealImage(m, holder) {
  holder.innerHTML = "";
  holder.append(el("div", { class: "img-placeholder" }, "Decrypting…"));
  try {
    const bytes = await fetchDecryptedFile(m);
    // Re-use the URL across re-renders; releaseObjectUrls() revokes it.
    if (!m.file._objectUrl) {
      m.file._objectUrl = URL.createObjectURL(new Blob([bytes], { type: m.file.mime }));
    }
    const url = m.file._objectUrl;
    holder.innerHTML = "";
    holder.append(
      el("img", {
        class: "msg-image", src: url, alt: m.file.filename, loading: "lazy",
        onclick: () => openLightbox(url, m.file.filename),
      }),
      el("div", { class: "img-meta" },
        el("span", {}, `${m.file.filename} · ${fmtBytes(m.file.size)}`),
        el("button", {
          class: "file-dl",
          onclick: () => download(m.file.filename, bytes, m.file.mime),
        }, "Save")));
  } catch (err) {
    holder.innerHTML = "";
    holder.append(el("div", { class: "msg-error" },
      "⚠ " + (err.message || "Could not decrypt image")));
  }
}

function openLightbox(url, name) {
  const box = el("div", { class: "lightbox", onclick: () => box.remove() },
    el("img", { src: url, alt: name }));
  document.body.append(box);
}

// Fetch the ciphertext blob and decrypt it to bytes. Split out from
// downloadFile() so inline previews can reuse the same path.
async function fetchDecryptedFile(m) {
  const cipher = await api.downloadFile(m.file.file_id);
  const senderKeys = await getPeerKeys(m.from);
  return C.decryptFile(
    cipher, m.file.payload, state.identity.username,
    state.identity.kem.secretKey, senderKeys.dsa_public_key, m.file.ctx || "");
}

async function downloadFile(m) {
  try {
    toast("Downloading & decrypting…");
    const plain = await fetchDecryptedFile(m);
    download(m.file.filename, plain, m.file.mime || "application/octet-stream");
  } catch (err) {
    toast(err.message || "Download failed", "error");
  }
}

// Object URLs created for inline media are owned by the message that made them.
// Release them whenever those messages are discarded, or the blobs leak for the
// lifetime of the tab.
function releaseObjectUrls(messages) {
  for (const m of messages || []) {
    if (m.file && m.file._objectUrl) {
      URL.revokeObjectURL(m.file._objectUrl);
      m.file._objectUrl = null;
    }
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
  const sendBtn = $("#send-btn");
  const text = input.value.trim();
  if (!text || !c) return;

  // Clear optimistically so typing feels instant, but keep `text` so a failed
  // send can put the draft back instead of destroying it.
  input.value = "";
  autosize(input);
  sendBtn.disabled = true;

  try {
    if (c.type === "group") await ensureGroupLoaded(c.id);
    else await getPeerKeys(c.id);
    const payload = await C.encryptMessage(text, recipientsFor(c), state.identity.dsa.secretKey, ctxFor(c));
    const ttl = getTtl(c.cid) || undefined;
    let env;
    if (c.type === "group") env = await api.sendGroupMessage(c.id, { payload, ttl });
    else env = await api.sendMessage({ recipient: c.id, payload, ttl });
    playSent();
    setDraft(c.cid, "");
    if (c.type === "group") await ingestGroup(env, { live: false });
    else await ingestDm(env, { live: false });
    renderMessages({ force: true }); renderContacts();
  } catch (err) {
    // Restore the draft. If the user started typing again while the send was in
    // flight, keep both rather than clobbering the newer text.
    input.value = input.value ? text + "\n" + input.value : text;
    autosize(input);
    // Setting .value programmatically fires no input event, so persist the
    // restored draft here rather than waiting on the debounced handler.
    setDraft(c.cid, input.value);
    toast((err.message || "Send failed") + " — your message is still in the box", "error");
  } finally {
    sendBtn.disabled = !input.value.trim();
    input.focus();
  }
}

// Lock the composer while a file is being encrypted and uploaded, and say
// which stage it's at — encrypting a large file is a long, silent pause.
let _composerBusy = false;
function setComposerBusy(busy, label = "") {
  _composerBusy = busy;
  const status = $("#composer-status");
  status.textContent = label;
  status.hidden = !busy;
  $("#attach-btn").disabled = busy;
  $("#send-btn").disabled = busy || !$("#msg-input").value.trim();
}

function onAttachFile(e) {
  const file = e.target.files[0];
  e.target.value = "";
  sendFile(file);
}

async function sendFile(file) {
  const c = curConvo();
  if (!file || !c) return;
  if (_composerBusy) return toast("Still sending the previous file…", "error");
  // Check the size before encrypting — otherwise a large file costs a full
  // client-side encryption pass only to be rejected with a 413 on upload.
  if (file.size > MAX_UPLOAD_BYTES) {
    return toast(
      `${file.name} is ${fmtBytes(file.size)} — this relay accepts up to ${fmtBytes(MAX_UPLOAD_BYTES)}`,
      "error");
  }
  try {
    if (c.type === "group") await ensureGroupLoaded(c.id);
    else await getPeerKeys(c.id);
    setComposerBusy(true, `Encrypting ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = { filename: file.name, mime: file.type || "application/octet-stream", size: bytes.length };
    const { cipherBytes, payload } = await C.encryptFile(
      bytes, meta, recipientsFor(c), state.identity.dsa.secretKey, ctxFor(c));
    setComposerBusy(true, `Uploading ${fmtBytes(bytes.length)}…`);
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
    renderMessages({ force: true }); renderContacts();
    toast("File sent (encrypted)", "success");
  } catch (err) {
    toast(err.message || "File send failed", "error");
  } finally {
    setComposerBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Chat header menu (disappearing / block / group info)
// ---------------------------------------------------------------------------
function toggleChatMenu(e) {
  e.stopPropagation();
  const menu = $("#chat-menu");
  if (!menu.hidden) { closeChatMenu(); return; }
  const c = curConvo();
  if (!c) return;
  menu.innerHTML = "";
  menu.append(el("button", { role: "menuitem", onclick: () => { closeChatMenu(); openTtl(c); } }, "⏲ Disappearing messages"));
  if (c.type === "dm") {
    const blocked = state.blocked.has(c.id);
    menu.append(el("button", { role: "menuitem", class: blocked ? "" : "danger", onclick: () => { closeChatMenu(); blocked ? unblockUser(c.id) : blockUser(c.id); } },
      blocked ? "✔ Unblock user" : "🚫 Block user"));
  } else {
    menu.append(el("button", { role: "menuitem", onclick: () => { closeChatMenu(); openGroupInfo(c); } }, "👥 Group info"));
  }
  menu.hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
  visibleFocusable(menu)[0]?.focus();
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
    grid.append(el("button", {
      class: "ttl-opt" + (o.v === cur ? " active" : ""),
      role: "radio", "aria-checked": String(o.v === cur),
      onclick: () => {
        setTtlPref(convo.cid, o.v);
        closeModal($("#ttl-modal"));
        toast(o.v ? `Disappearing messages: ${o.label}` : "Disappearing messages off");
      },
    }, o.label));
  }
  openModal("ttl-modal", ".ttl-opt");
}
function wireTtlModal() {
  $("#ttl-close").onclick = () => closeModal($("#ttl-modal"));
}

// ---------------------------------------------------------------------------
// User search modal (new DM)
// ---------------------------------------------------------------------------
function openUserSearch() {
  const modal = $("#search-modal");
  const input = $("#search-input");
  input.value = ""; $("#search-results").innerHTML = "";
  openModal(modal, "#search-input");
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
          box.append(searchItem(`Start a chat with ${r.username}`, () => {
            closeModal(modal); ensureDmConvo(r.username); selectConversation(dmCid(r.username));
          },
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
  openModal(modal, "#fp-close");
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
  openModal("group-modal", "#group-name");
}
function renderGroupChips() {
  const box = $("#group-members-chips"); box.innerHTML = "";
  for (const [u] of _newGroupMembers) {
    box.append(el("span", { class: "chip" }, u,
      el("button", { onclick: () => { _newGroupMembers.delete(u); renderGroupChips(); } }, "✕")));
  }
}
function wireGroupModals() {
  $("#group-close").onclick = () => closeModal($("#group-modal"));
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
          box.append(searchItem(`Add ${r.username} to the group`, () => {
            _newGroupMembers.set(r.username, r); renderGroupChips();
            $("#group-member-search").value = ""; box.innerHTML = "";
            $("#group-member-search").focus();
          }, avatarEl({ name: r.username, avatar: r.avatar }),
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
      closeModal($("#group-modal"));
      await selectConversation(groupCid(group.id));
      renderContacts();
      toast("Group created", "success");
    } catch (err) { toast(err.message || "Could not create group", "error"); }
  };

  $("#gi-close").onclick = () => closeModal($("#groupinfo-modal"));
  $("#gi-leave").onclick = async () => {
    const c = curConvo(); if (!c || c.type !== "group") return;
    const ok = await askModal({
      title: "Leave group",
      body: `You'll stop receiving messages in “${c.meta.name}”. Messages already on this device stay here.`,
      confirmText: "Leave group", danger: true,
    });
    if (!ok) return;
    try {
      await api.removeGroupMember(c.id, state.identity.username);
      delete state.convos[groupCid(c.id)];
      state.current = null; closeModal($("#groupinfo-modal"));
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
          rbox.append(searchItem(`Add ${r.username} to the group`, async () => {
            try { await api.addGroupMember(g.id, r.username); await openGroupInfo(convo); } catch (err) { toast(err.message, "error"); }
          }, avatarEl({ name: r.username, avatar: r.avatar }), el("div", { class: "contact-name" }, r.username)));
        }
      }, 220);
    };
  }
  openModal("groupinfo-modal");
}

// ---------------------------------------------------------------------------
// Share link / QR
// ---------------------------------------------------------------------------
function myShareUrl() {
  const id = state.identity;
  return `${shareOrigin()}/#add=${encodeURIComponent(id.username)}&fp=${id.fingerprint}`;
}
function wireShareModal() {
  $("#share-close").onclick = () => closeModal($("#share-modal"));
  $("#share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#share-url-input").value); toast("Link copied", "success"); }
    catch { $("#share-url-input").select(); document.execCommand("copy"); toast("Link copied", "success"); }
  };
}
function openShare() {
  const url = myShareUrl();
  $("#share-url-input").value = url;
  drawQr($("#qr-canvas"), url);
  openModal("share-modal", "#share-copy");
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
// Relay server dialog
//
// Opened from the sign-in screen (so a relay can be chosen before an account
// exists or a vault is unlocked) and from Settings. Validates the URL as it is
// typed, can test it — reachability, that it really is a Lattix relay, and
// that WebSocket upgrades survive the reverse proxy — and saves it.
// ---------------------------------------------------------------------------
let _serverAfterClose = null;

function defaultRelayDescription() {
  if (isExtension()) return `the relay at ${defaultServer()}`;
  if (isLocalHost(location.hostname)) return `the relay built into this app (${location.host})`;
  return `the relay this app was loaded from (${location.host})`;
}

function showServerResult(kind, title, lines = []) {
  const box = $("#server-result");
  box.hidden = false;
  box.className = `server-result ${kind}`;
  box.replaceChildren(
    el("span", { class: "result-title" }, title),
    ...lines.filter(Boolean).map((l) => el("div", {}, l)),
  );
}

/** Validate the field; returns the normalised result and updates the hint. */
function validateServerField() {
  const v = normalizeServerUrl($("#server-url").value);
  const hint = $("#server-hint");
  if (v.error) { hint.className = "fine err"; hint.textContent = v.error; }
  else if (!v.url) { hint.className = "fine"; hint.textContent = `Empty uses ${defaultRelayDescription()}.`; }
  else if (v.warning) { hint.className = "fine warn"; hint.textContent = v.warning; }
  else { hint.className = "fine"; hint.textContent = `Will connect to ${v.url}`; }
  return v;
}

/** The API base a normalised URL means ("" when it is this page's origin). */
function baseFor(url) {
  if (!url) return defaultServer();
  if (!isExtension() && url === location.origin) return "";
  return url;
}

async function testServer(url) {
  const base = baseFor(url);
  showServerResult("", "Testing…", [`Contacting ${serverOrigin(base)}`]);
  $("#server-test").disabled = true;
  try {
    const r = await probeRelay(base);
    if (!r.ok) {
      showServerResult("err", "Connection failed", [r.error]);
    } else {
      const socketLine = r.socket === "ok"
        ? "WebSocket: working — upgrades reach the relay"
        : "WebSocket: not checked (this relay predates the check — upgrade it to 2.1+)";
      showServerResult(r.socket === "ok" ? "ok" : "warn", "Relay reachable", [
        `Lattix ${r.version || "relay"} at ${serverOrigin(base)}`,
        `Response time: ${r.latencyMs} ms`,
        socketLine,
      ]);
    }
    return r;
  } finally {
    $("#server-test").disabled = false;
  }
}

function openServerModal({ afterClose = null } = {}) {
  _serverAfterClose = afterClose;
  $("#server-url").value = getServerUrl();
  $("#server-result").hidden = true;
  validateServerField();
  openModal("server-modal", "#server-url");
}

function closeServerModal() {
  closeModal($("#server-modal"));
}

function wireServerModal() {
  const modal = $("#server-modal");
  $("#server-close").onclick = closeServerModal;
  $("#server-cancel").onclick = closeServerModal;
  modal.addEventListener("lattix:dismissed", () => {
    const fn = _serverAfterClose;
    _serverAfterClose = null;
    if (fn) fn();
  });

  $("#server-url").addEventListener("input", () => {
    $("#server-result").hidden = true;
    validateServerField();
  });
  $("#server-test").onclick = () => {
    const v = validateServerField();
    if (v.error) return $("#server-url").focus();
    testServer(v.url);
  };
  $("#server-reset").onclick = () => {
    $("#server-url").value = "";
    $("#server-result").hidden = true;
    validateServerField();
    $("#server-url").focus();
  };

  $("#server-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = validateServerField();
    if (v.error) return $("#server-url").focus();

    const stored = v.url && baseFor(v.url) === "" ? "" : v.url;
    if (baseFor(stored) === apiBase()) {
      if (stored !== getServerUrl()) setServerUrl(stored);  // tidy equivalent spellings
      closeServerModal();
      return toast(`Already using ${serverLabel()}`);
    }

    const save = $("#server-save");
    save.disabled = true;
    let result;
    try { result = await testServer(v.url); }
    finally { save.disabled = false; }

    if (!result.ok) {
      const anyway = await askModal({
        title: "Save a relay that didn't answer?",
        body: `${result.error} You can save it anyway — for example if the server isn't set up yet — ` +
              `and Lattix will keep trying to connect.`,
        confirmText: "Save anyway", cancelText: "Keep editing",
      });
      if (!anyway) return $("#server-url").focus();
    }

    if (state.identity) {
      const go = await askModal({
        title: "Switch relay?",
        body: `Lattix will sign out of ${serverLabel()} and reload. Unlock with your password to connect to ` +
              `${serverLabel(baseFor(stored))}. Accounts and conversations belong to a relay — if this ` +
              `identity isn't registered there yet, you'll be offered to register it.`,
        confirmText: "Switch and reload",
      });
      if (!go) return;
      await api.logout();          // against the OLD relay, before switching
      setServerUrl(stored);
      _serverAfterClose = null;
      location.reload();
      return;
    }

    setServerUrl(stored);
    _serverAfterClose = null;
    closeServerModal();
    refreshAuthRelay();
    toast(`Relay set to ${serverLabel()}`, "success");
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function wireSettings() {
  $("#settings-close").onclick = () => closeModal($("#settings-modal"));

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

  $("#toggle-autoimg").onchange = (e) => {
    localStorage.setItem(AUTOIMG_KEY, e.target.checked ? "1" : "0");
    if (curConvo()) renderMessages({ force: false });
  };

  $("#avatar-upload-btn").onclick = () => $("#avatar-file").click();
  $("#avatar-file").onchange = onAvatarChosen;
  $("#avatar-remove-btn").onclick = async () => {
    try { await api.setAvatar(null); state.identity.avatar = null; state.peers[state.identity.username].avatar = null; renderSelf(); refreshSettingsUi(); renderContacts(); toast("Profile image removed"); }
    catch (err) { toast(err.message, "error"); }
  };

  $("#server-change-btn").onclick = () => openServerModal();

  $("#export-json-btn").onclick = exportChatJson;
  $("#backup-btn").onclick = makeBackup;
  $("#restore-btn").onclick = () => $("#restore-file").click();
  $("#restore-file").onchange = onRestoreChosen;
  $("#export-vault-btn").onclick = exportVault;
  $("#delete-data-btn").onclick = deleteAppData;
}

function openSettings() { refreshSettingsUi(); openModal("settings-modal", "#theme-choices .choice"); }

function refreshSettingsUi() {
  const theme = currentTheme(), color = currentChatColor();
  $$("#theme-choices .choice").forEach((b) => {
    const on = b.dataset.theme === theme;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $$("#chat-swatches .swatch").forEach((s) => {
    const on = s.dataset.c === color;
    s.classList.toggle("active", on);
    s.setAttribute("aria-checked", String(on));
  });
  $("#toggle-sounds").checked = soundsEnabled();
  $("#toggle-notify").checked = localStorage.getItem(NOTIFY_KEY) === "1";
  $("#toggle-autoimg").checked = autoImages();
  fillAvatar($("#avatar-preview"), { name: state.identity.username, avatar: state.identity.avatar });
  $("#server-current").textContent = usingRemoteServer() ? serverLabel() : "This server";
  $("#server-current-sub").textContent = usingRemoteServer()
    ? `${serverOrigin()}${state.connected ? " — connected" : " — not connected"}`
    : `Using the relay this app was loaded from (${location.host}).`;
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
  const password = await askModal({
    title: "Encrypt this backup",
    body: "The file is sealed with PBKDF2 + AES-GCM. There is no recovery if you forget this password.",
    input: {
      type: "password", label: "Backup password",
      placeholder: "At least 8 characters", confirmLabel: "Repeat password",
      minLength: 8,
    },
    confirmText: "Create backup",
  });
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
  const password = await askModal({
    title: "Restore backup",
    body: `Decrypting ${file.name}. Restored messages are merged into this device's history.`,
    input: {
      type: "password", label: "Backup password",
      placeholder: "The password used when the backup was made",
    },
    confirmText: "Restore",
  });
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
  const ok = await askModal({
    title: "Delete all Lattix data",
    body: "This erases this device's vault, chats and settings, and deletes your account on the relay. " +
          "Your private keys cannot be recovered afterwards — export your vault first if you may want this " +
          "identity back.",
    requireText: state.identity.username,
    confirmText: "Delete everything", danger: true,
  });
  if (!ok) return;
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
wireServerModal();
showAuth();
