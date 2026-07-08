// Lattix — network layer (REST + WebSocket). Transports ONLY ciphertext.

export class LattixApi {
  constructor() {
    this.token = null;
    this.username = null;
    this.ws = null;
    this.handlers = { envelope: [], presence: [], status: [] };
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
    const res = await fetch(path, { method, headers, body: payload });
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
  _setSession(tokenResp) {
    this.token = tokenResp.token;
    this.username = tokenResp.username;
  }

  // ---- directory ----
  me() {
    return this._req("GET", "/api/me");
  }
  getUser(username) {
    return this._req("GET", `/api/users/${encodeURIComponent(username)}`);
  }
  searchUsers(q) {
    return this._req("GET", `/api/users?q=${encodeURIComponent(q)}`);
  }

  // ---- messaging ----
  sendMessage(payload) {
    return this._req("POST", "/api/messages", { body: payload });
  }
  sendFileMessage(payload) {
    return this._req("POST", "/api/messages/file", { body: payload });
  }
  conversation(peer, since = 0) {
    return this._req("GET", `/api/conversations/${encodeURIComponent(peer)}?since=${since}`);
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
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
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
