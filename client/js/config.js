// Lattix — runtime configuration: which relay server this client talks to.
//
// Every build can be pointed at any relay from the sign-in screen or
// Settings → Relay server:
//
//   * Web app served by a relay — defaults to that same relay (same origin).
//   * Desktop apps — open the UI from their bundled local relay
//     (http://localhost:8000) and default to it, but can instead use a remote
//     relay, e.g. one on a VPS behind Caddy or nginx.
//   * Chrome extension — has no relay of its own; defaults to localhost:8000.
//
// The choice is stored per browser origin in localStorage.

const SERVER_KEY = "lattix.serverUrl";
const EXTENSION_DEFAULT = "http://localhost:8000";

function readStore(key) {
  try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
}
function writeStore(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {}
}

export function isExtension() {
  return location.protocol === "chrome-extension:";
}

const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|.+\.local|.+\.localhost)$/i;
const PRIVATE_IP_RE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/;

export function isLocalHost(hostname) {
  return LOCAL_HOST_RE.test(hostname);
}

/**
 * Validate and canonicalise what a user typed into the Server URL field.
 *
 * Returns { url, warning } on success or { error } on failure. An empty input
 * is valid and means "use the default relay" (url === "").
 *
 *   chat.example.com            → https://chat.example.com
 *   192.168.1.20:8000           → http://192.168.1.20:8000
 *   wss://chat.example.com/ws   → https://chat.example.com
 *   https://example.com/lattix/ → https://example.com/lattix
 */
export function normalizeServerUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) return { url: "" };

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // No scheme typed. Local and private-network addresses almost never have
    // a certificate; anything else on the internet should be HTTPS.
    const host = raw.split(/[/:?#]/)[0];
    raw = (isLocalHost(host) || PRIVATE_IP_RE.test(host) ? "http://" : "https://") + raw;
  }

  let u;
  try { u = new URL(raw); } catch (_) { return { error: "That doesn't look like a valid URL." }; }

  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "The relay URL must start with https:// or http://." };
  }
  if (u.username || u.password) {
    return { error: "Don't put a username or password in the relay URL." };
  }
  if (!u.hostname) return { error: "The relay URL needs a host name." };

  // People paste the WebSocket or an API URL; the relay base is what we need.
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(ws|api(\/.*)?)$/i, "");
  const url = `${u.protocol}//${u.host}${path}`;

  // A page loaded over HTTPS can't talk to an http:// relay (mixed content).
  if (location.protocol === "https:" && u.protocol === "http:" && !isLocalHost(u.hostname)) {
    return { error: "This page is loaded over HTTPS, so the browser will block an http:// relay. Use https://." };
  }

  let warning = "";
  if (u.protocol === "http:" && !isLocalHost(u.hostname) && !PRIVATE_IP_RE.test(u.hostname)) {
    warning = "Plain http:// over the internet exposes your login token and metadata to the network. " +
              "Messages stay end-to-end encrypted, but put the relay behind HTTPS (Caddy or nginx).";
  }
  return { url, warning };
}

/** The relay used when nothing is configured ("" = same origin as the page). */
export function defaultServer() {
  return isExtension() ? EXTENSION_DEFAULT : "";
}

/** The user-configured relay URL, or "" when using the default. */
export function getServerUrl() {
  return readStore(SERVER_KEY).trim().replace(/\/+$/, "");
}

/** Store a relay URL (already normalised), or clear it with "". */
export function setServerUrl(url) {
  writeStore(SERVER_KEY, String(url || "").trim().replace(/\/+$/, ""));
}

/** Base URL prepended to every REST path ("" = same origin). */
export function apiBase() {
  const stored = getServerUrl();
  if (stored) {
    // A relay that happens to be this page's own origin is same-origin.
    if (!isExtension() && stored === location.origin) return "";
    return stored;
  }
  return defaultServer();
}

/** Absolute http(s) URL of the relay in use. */
export function serverOrigin(base = apiBase()) {
  return base || location.origin;
}

/** ws:// or wss:// URL for the relay's WebSocket. */
export function wsUrl(base = apiBase()) {
  return serverOrigin(base).replace(/^http/i, "ws").replace(/\/+$/, "") + "/ws";
}

/** Short human label for the relay in use, e.g. "chat.example.com". */
export function serverLabel(base = apiBase()) {
  try { return new URL(serverOrigin(base)).host; } catch (_) { return serverOrigin(base); }
}

/** True when the client is talking to a relay other than the page's own. */
export function usingRemoteServer() {
  return apiBase() !== "";
}

/**
 * Origin used to build share links / QR codes. The link opens the web app
 * served by the relay, so it must point at the relay everyone shares — not at
 * a desktop app's private http://localhost:8000 or a chrome-extension:// URL.
 */
export function shareOrigin() {
  return serverOrigin().replace(/\/+$/, "");
}
