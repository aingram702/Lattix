// Lattix — runtime configuration.
//
// The web app is served by the relay itself, so it talks to the same origin.
// The Chrome extension is loaded from a chrome-extension:// origin and must be
// pointed at a running relay; that URL is stored locally and configurable in
// Settings.

const SERVER_KEY = "lattix.serverUrl";

export function isExtension() {
  return location.protocol === "chrome-extension:";
}

export function apiBase() {
  const stored = (localStorage.getItem(SERVER_KEY) || "").trim();
  if (stored) return stored.replace(/\/+$/, "");
  if (isExtension()) return "http://localhost:8000";
  return ""; // same-origin
}

export function setServerUrl(url) {
  const v = (url || "").trim();
  if (v) localStorage.setItem(SERVER_KEY, v.replace(/\/+$/, ""));
  else localStorage.removeItem(SERVER_KEY);
}

export function getServerUrl() {
  return localStorage.getItem(SERVER_KEY) || "";
}

// The public origin used to build share links / QR codes. In the extension we
// can't share a chrome-extension:// URL, so fall back to the configured server.
export function shareOrigin() {
  if (isExtension()) return apiBase() || location.origin;
  return location.origin;
}
