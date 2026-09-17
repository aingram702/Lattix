// Lattix — network layer (REST + WebSocket). Transports ONLY ciphertext.
//
// Built to run well against a remote relay behind a reverse proxy (Caddy,
// nginx, a VPS on the other side of the world) rather than only a relay on
// localhost:
//
//   * every request has a timeout, and reads retry through the transient
//     502/503/504s a proxy returns while the relay behind it restarts;
//   * network failures become readable errors that name the relay;
//   * the relay keeps sessions in memory, so a relay restart (a deploy, a VPS
//     reboot) invalidates every token — the client transparently logs back in
//     with the identity already unlocked in memory and retries;
//   * the WebSocket authenticates with its first frame instead of a ?token=
//     query string, which proxies write to their access logs;
//   * a ping/pong watchdog notices sockets that died silently (proxy idle
//     timeouts, NAT rebinding, laptop sleep), with jittered backoff and an
//     immediate retry when the network or the tab comes back;
//   * reconnects are reported as such so the app can fetch what it missed.

import { apiBase, wsUrl, serverLabel } from "./config.js";

const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const READ_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([502, 503, 504]);
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const WS_READY_TIMEOUT_MS = 15_000;
const ALIVE_CHECK_MS = 5_000;
const MAX_BACKOFF_MS = 20_000;
// Auth endpoints never trigger an automatic re-login (that would recurse, or
// turn a wrong password into a loop).
const NO_REAUTH = new Set(["/api/login", "/api/register", "/api/logout"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RelayError extends Error {
  constructor(message, { status = 0, network = false, timeout = false } = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.network = network;
    this.timeout = timeout;
  }
}

function statusMessage(status, detail) {
  if (detail) return detail;
  if (status === 413) return "That upload is larger than the relay (or the proxy in front of it) accepts.";
  if (status === 502 || status === 504) return `The relay's proxy couldn't reach the Lattix server behind it (HTTP ${status}). Try again shortly.`;
  if (status === 503) return "The relay is temporarily unavailable (HTTP 503). Try again shortly.";
  return `The relay answered HTTP ${status}.`;
}

async function readDetail(res) {
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await res.json();
      if (typeof body.detail === "string") return body.detail;
      if (Array.isArray(body.detail) && body.detail[0]?.msg) return body.detail[0].msg;
    }
  } catch (_) {}
  return "";
}

/** fetch() with a timeout, turning transport failures into RelayErrors. */
async function timedFetch(url, init, timeoutMs, base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new RelayError(`The relay at ${serverLabel(base)} took too long to answer.`, { timeout: true });
    }
    throw new RelayError(
      `Can't reach the relay at ${serverLabel(base)}. Check your connection, or the address in Relay server settings.`,
      { network: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a relay before switching to it: is it reachable, is it really a
 * Lattix relay, and do WebSocket upgrades make it through the proxy?
 *
 * `base` is a normalised relay URL ("" = this page's own origin).
 * Resolves to { ok, version, latencyMs, features, socket, error }, where
 * socket is "ok" | "failed" | "skipped".
 */
export async function probeRelay(base, { timeoutMs = 8_000, checkSocket = true } = {}) {
  const origin = base || location.origin;
  const label = serverLabel(base);
  const out = { ok: false, version: "", latencyMs: 0, features: [], socket: "skipped", error: "" };

  const started = performance.now();
  let res;
  try {
    res = await timedFetch(`${origin}/api/health`, { cache: "no-store" }, timeoutMs, base);
  } catch (err) {
    out.error = err.timeout
      ? `${label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`
      : `Couldn't reach ${label}. Check the address, that the proxy is running with a valid HTTPS ` +
        `certificate, and that the firewall allows ports 80/443. A relay older than 2.1 also has to ` +
        `allow this app's origin (LATTIX_CORS_ORIGINS).`;
    return out;
  }
  out.latencyMs = Math.round(performance.now() - started);

  if (!res.ok) {
    out.error = res.status === 404
      ? `${label} is up, but /api/health wasn't found — is the proxy forwarding to the Lattix relay?`
      : statusMessage(res.status, await readDetail(res));
    return out;
  }
  let health = null;
  try { health = await res.json(); } catch (_) {}
  if (!health || health.status !== "ok") {
    out.error = `${label} answered, but not like a Lattix relay. Check the proxy's upstream address.`;
    return out;
  }
  out.ok = true;
  out.version = health.version || "";
  out.features = Array.isArray(health.features) ? health.features : [];

  if (checkSocket && out.features.includes("ws-auth-message")) {
    out.socket = await probeSocket(base, timeoutMs);
    if (out.socket === "failed") {
      out.ok = false;
      out.error = `HTTPS works, but WebSocket connections aren't getting through to ${label}. ` +
                  `The reverse proxy must forward the Upgrade and Connection headers for /ws.`;
    }
  }
  return out;
}

/** Open a socket with an empty token: a relay that closes it with 4401 has
 *  proven the upgrade crossed the proxy and reached the app. */
function probeSocket(base, timeoutMs) {
  return new Promise((resolve) => {
    let ws, settled = false, opened = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (_) {}
      resolve(v);
    };
    const timer = setTimeout(() => done(opened ? "ok" : "failed"), timeoutMs);
    try { ws = new WebSocket(wsUrl(base)); } catch (_) { return done("failed"); }
    ws.onopen = () => { opened = true; try { ws.send(JSON.stringify({ type: "auth", token: "" })); } catch (_) {} };
    ws.onclose = (ev) => done(opened || ev.code === 4401 ? "ok" : "failed");
    ws.onerror = () => { if (!opened) done("failed"); };
  });
}

export class LattixApi {
  constructor() {
    this.token = null;
    this.username = null;
    this.ws = null;
    this.connected = false;
    this.features = null;          // from /api/health; null until known
    this.handlers = { envelope: [], group_envelope: [], group: [], presence: [], status: [], auth: [] };

    this._reauth = null;           // () => Promise<TokenResponse>
    this._reauthing = null;
    this._wantSocket = false;
    this._everConnected = false;
    this._backoff = 1000;
    this._gen = 0;
    this._lastSeen = 0;

    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        if (!this._wantSocket) return;
        if (this.connected) this._checkAlive(); else this.reconnectNow();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || !this._wantSocket) return;
        // Timers are throttled in background tabs and laptops sleep; a socket
        // that looks open may have been dead for an hour.
        if (this.connected) this._checkAlive(); else this.reconnectNow();
      });
    }
  }

  // ---- events ----
  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }
  _emit(event, data) {
    (this.handlers[event] || []).forEach((fn) => fn(data));
  }

  /** Register how to obtain a fresh token when the relay forgets ours. */
  setReauth(fn) {
    this._reauth = fn;
  }

  // ---- low-level fetch ----
  async _send(method, path, { body, form, timeout }) {
    const headers = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let payload;
    if (form) {
      payload = form; // FormData sets its own content-type
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const base = apiBase();
    return timedFetch(base + path, { method, headers, body: payload, cache: "no-store" },
                      timeout || REQUEST_TIMEOUT_MS, base);
  }

  async _req(method, path, opts = {}) {
    // Only reads are retried: a POST whose response was lost may already have
    // been stored, and replaying it would duplicate a message.
    const attempts = method === "GET" ? READ_ATTEMPTS : 1;
    let reauthed = false;

    for (let attempt = 0; ; attempt++) {
      const tokenUsed = this.token;
      let res;
      try {
        res = await this._send(method, path, opts);
      } catch (err) {
        if (attempt + 1 < attempts) { await sleep(500 * 2 ** attempt); continue; }
        throw err;
      }

      if (res.status === 401 && tokenUsed && !NO_REAUTH.has(path) && !reauthed) {
        reauthed = true;
        // Another request may already have renewed the token while this one
        // was in flight; if so just retry with the new one.
        const renewed = this.token !== tokenUsed || (await this._relogin()) === "ok";
        if (renewed) { attempt--; continue; }
      }

      if (!res.ok && RETRY_STATUSES.has(res.status) && attempt + 1 < attempts) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new RelayError(statusMessage(res.status, await readDetail(res)), { status: res.status });
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return res.json();
      return res;
    }
  }

  /** Single-flight re-login. Resolves "ok", "denied" (credentials rejected)
   *  or "error" (relay unreachable — worth retrying later). */
  _relogin() {
    if (!this._reauth) return Promise.resolve("denied");
    if (!this._reauthing) {
      this._reauthing = (async () => {
        try {
          const t = await this._reauth();
          this._setSession(t);
          this._emit("auth", { renewed: true });
          return "ok";
        } catch (err) {
          if (err && (err.status === 401 || err.status === 403 || err.status === 404)) {
            this._emit("auth", { renewed: false, error: err });
            return "denied";
          }
          return "error";
        } finally {
          this._reauthing = null;
        }
      })();
    }
    return this._reauthing;
  }

  // ---- auth ----
  async register(payload) {
    const t = await this._req("POST", "/api/register", { body: payload });
    this._setSession(t);
    return t;
  }
  async login(username, authSecret) {
    const t = await this._req("POST", "/api/login", {
      body: { username, auth_secret: authSecret },
    });
    this._setSession(t);
    return t;
  }
  async logout() {
    this._wantSocket = false;
    try {
      await this._req("POST", "/api/logout", { timeout: 5_000 });
    } catch (_) {}
    this._closeSocket();
    this.token = null;
    this.username = null;
  }
  deleteAccount() {
    return this._req("DELETE", "/api/me");
  }
  _setSession(tokenResp) {
    this.token = tokenResp.token;
    this.username = tokenResp.username;
  }

  // ---- relay capabilities ----
  async health() {
    const h = await this._req("GET", "/api/health", { timeout: 10_000 });
    this.features = Array.isArray(h?.features) ? h.features : [];
    return h;
  }

  // ---- directory / profile ----
  me() {
    return this._req("GET", "/api/me");
  }
  getUser(username) {
    return this._req("GET", `/api/users/${encodeURIComponent(username)}`);
  }
  searchUsers(q) {
    return this._req("GET", `/api/users?q=${encodeURIComponent(q)}`);
  }
  setAvatar(avatar) {
    return this._req("PUT", "/api/me/avatar", { body: { avatar } });
  }

  // ---- messaging (1:1) ----
  sendMessage(payload) {
    return this._req("POST", "/api/messages", { body: payload });
  }
  sendFileMessage(payload) {
    return this._req("POST", "/api/messages/file", { body: payload });
  }
  conversation(peer, since = 0) {
    return this._req("GET", `/api/conversations/${encodeURIComponent(peer)}?since=${since}`);
  }

  // ---- groups ----
  createGroup(payload) {
    return this._req("POST", "/api/groups", { body: payload });
  }
  listGroups() {
    return this._req("GET", "/api/groups");
  }
  getGroup(id) {
    return this._req("GET", `/api/groups/${id}`);
  }
  addGroupMember(id, username) {
    return this._req("POST", `/api/groups/${id}/members`, { body: { username } });
  }
  removeGroupMember(id, username) {
    return this._req("DELETE", `/api/groups/${id}/members/${encodeURIComponent(username)}`);
  }
  sendGroupMessage(id, payload) {
    return this._req("POST", `/api/groups/${id}/messages`, { body: payload });
  }
  sendGroupFile(id, payload) {
    return this._req("POST", `/api/groups/${id}/messages/file`, { body: payload });
  }
  groupMessages(id, since = 0) {
    return this._req("GET", `/api/groups/${id}/messages?since=${since}`);
  }

  // ---- files ----
  async uploadFile(cipherBytes, plaintextSize) {
    const form = new FormData();
    form.append("file", new Blob([cipherBytes], { type: "application/octet-stream" }), "blob");
    form.append("size", String(plaintextSize));
    return this._req("POST", "/api/files", { form, timeout: TRANSFER_TIMEOUT_MS });
  }
  async downloadFile(fileId) {
    const res = await this._req("GET", `/api/files/${encodeURIComponent(fileId)}`, { timeout: TRANSFER_TIMEOUT_MS });
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---- websocket ----
  connectSocket() {
    if (!this.token) return;
    this._wantSocket = true;
    this._openSocket();
  }

  async _openSocket() {
    this._closeSocket();
    const gen = ++this._gen;
    if (!this.token) return;

    // Learn whether the relay takes the token in the first frame. Relays
    // before 2.1 only accept ?token=, so fall back to that for them.
    if (this.features === null) {
      try { await this.health(); } catch (_) {}
      if (gen !== this._gen || !this.token || !this._wantSocket) return;
      if (this.features === null) {
        // Relay unreachable — the socket would fail too.
        this._emit("status", { connected: false });
        this._scheduleReconnect();
        return;
      }
    }
    const messageAuth = this.features.includes("ws-auth-message");
    const url = messageAuth ? wsUrl() : `${wsUrl()}?token=${encodeURIComponent(this.token)}`;

    let ws;
    try { ws = new WebSocket(url); }
    catch (_) { this._scheduleReconnect(); return; }
    this.ws = ws;
    this._lastSeen = Date.now();

    // Neither an open nor a "ready" within the window means a proxy is holding
    // the upgrade (or the relay is wedged) — give up on this attempt.
    this._readyTimer = setTimeout(() => {
      if (this.ws === ws && !this.connected) this._dropSocket(ws);
    }, WS_READY_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._lastSeen = Date.now();
      if (messageAuth) {
        try { ws.send(JSON.stringify({ type: "auth", token: this.token })); } catch (_) {}
      } else {
        this._markConnected();
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this._lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "ready") this._markConnected();
      else if (msg.type === "pong") { /* liveness only */ }
      else if (msg.type === "envelope") this._emit("envelope", msg.envelope);
      else if (msg.type === "group_envelope") this._emit("group_envelope", msg.envelope);
      else if (msg.type === "group") this._emit("group", msg);
      else if (msg.type === "presence") this._emit("presence", msg);
    };
    ws.onclose = (ev) => this._handleClose(ws, ev.code);
    ws.onerror = () => { /* onclose follows */ };

    this._pingSentAt = 0;
    this._ping = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // A relay that answers pings and has sent nothing since the previous
      // one is gone. Judged per ping rather than by wall-clock silence, so a
      // background tab whose timers are throttled to once a minute isn't
      // mistaken for a dead connection.
      if (this._supportsPong() && this.connected && this._pingSentAt &&
          this._lastSeen < this._pingSentAt && Date.now() - this._pingSentAt > PONG_TIMEOUT_MS) {
        this._dropSocket(ws);
        return;
      }
      try { ws.send("ping"); this._pingSentAt = Date.now(); } catch (_) {}
    }, PING_INTERVAL_MS);
  }

  _supportsPong() {
    return Array.isArray(this.features) && this.features.includes("ws-pong");
  }

  _markConnected() {
    clearTimeout(this._readyTimer);
    if (this.connected) return;
    this.connected = true;
    this._backoff = 1000;
    const reconnected = this._everConnected;
    this._everConnected = true;
    this._emit("status", { connected: true, reconnected });
  }

  _handleClose(ws, code) {
    if (this.ws !== ws) return;
    this._teardown();
    this._emit("status", { connected: false });
    if (!this.token || !this._wantSocket) return;

    if (code === 4401) {
      // The relay no longer knows our token — typically it restarted and its
      // in-memory sessions are gone. Log in again, then reconnect.
      this._relogin().then((r) => {
        if (!this._wantSocket) return;
        if (r === "ok") { this._backoff = 1000; this._openSocket(); }
        else if (r === "error") this._scheduleReconnect();
        // "denied": the account is gone or the credentials changed; the app
        // was told via the "auth" event and decides what to do.
      });
      return;
    }
    this._scheduleReconnect();
  }

  /** Abandon a socket that is dead or stuck, then treat it as closed. */
  _dropSocket(ws) {
    if (this.ws !== ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch (_) {}
    this._handleClose(ws, 4000);
  }

  /** Confirm an apparently-open socket still works; drop it if not. */
  _checkAlive() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._supportsPong()) return;
    const sent = Date.now();
    try { ws.send("ping"); } catch (_) { return this._dropSocket(ws); }
    setTimeout(() => {
      if (this.ws === ws && this._lastSeen < sent) this._dropSocket(ws);
    }, ALIVE_CHECK_MS);
  }

  _scheduleReconnect() {
    clearTimeout(this._retry);
    // Jitter so every client of a relay that just restarted doesn't reconnect
    // in the same instant.
    const delay = Math.round(this._backoff * (0.8 + Math.random() * 0.4));
    this._backoff = Math.min(this._backoff * 1.6, MAX_BACKOFF_MS);
    this._retry = setTimeout(() => { if (this._wantSocket) this._openSocket(); }, delay);
  }

  // Reconnect immediately, skipping whatever backoff is pending. Used by the
  // connection strip so a user who knows the network is back needn't wait.
  reconnectNow() {
    if (!this.token) return;
    clearTimeout(this._retry);
    this._backoff = 1000;
    this._wantSocket = true;
    this._openSocket();
  }

  _teardown() {
    if (this._ping) clearInterval(this._ping);
    clearTimeout(this._readyTimer);
    this._ping = null;
    this.ws = null;
    this.connected = false;
  }

  _closeSocket() {
    clearTimeout(this._retry);
    const ws = this.ws;
    this._teardown();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (_) {}
    }
  }
}
