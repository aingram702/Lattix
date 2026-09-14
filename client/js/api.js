// Lattix — network layer (REST + WebSocket). Transports ONLY ciphertext.

import { apiBase } from "./config.js";

export class LattixApi {
  constructor() {
    this.token = null;
    this.username = null;
    this.ws = null;
    this.handlers = { envelope: [], group_envelope: [], group: [], presence: [], status: [] };
  }

  // ---- events ----
  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }
  _emit(event, data) {
    (this.handlers[event] || []).forEach((fn) => fn(data));
  }

  // ---- low-level fetch ----
  async _req(method, path, { body, form } = {}) {
    const headers = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let payload;
    if (form) {
      payload = form; // FormData sets its own content-type
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(apiBase() + path, { method, headers, body: payload });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res;
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
    try {
      await this._req("POST", "/api/logout");
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
    return this._req("POST", "/api/files", { form });
  }
  async downloadFile(fileId) {
    const res = await this._req("GET", `/api/files/${encodeURIComponent(fileId)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---- websocket ----
  connectSocket() {
    if (!this.token) return;
    this._closeSocket();
    const base = apiBase();
    let url;
    if (base) {
      url = base.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(this.token)}`;
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      url = `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this._emit("status", { connected: true });
    ws.onclose = () => {
      this._emit("status", { connected: false });
      // auto-reconnect while logged in
      if (this.token) setTimeout(() => this.connectSocket(), 2000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "envelope") this._emit("envelope", msg.envelope);
      else if (msg.type === "group_envelope") this._emit("group_envelope", msg.envelope);
      else if (msg.type === "group") this._emit("group", msg);
      else if (msg.type === "presence") this._emit("presence", msg);
    };

    // heartbeat
    this._ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  }

  _closeSocket() {
    if (this._ping) clearInterval(this._ping);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}
