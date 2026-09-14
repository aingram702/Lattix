// Lattix — appearance (theme + chat color) persistence.
//
// "system" is a stored *preference*, not a palette: it resolves to dark or
// light from prefers-color-scheme and follows the OS live. The four concrete
// themes are the palettes defined in css/styles.css.
//
// The same resolution runs in js/preload.js before first paint. Keep the two
// in step — preload.js is what stops a flash of the wrong theme.

export const THEMES = ["system", "dark", "light", "monokai", "kali"];
export const CHAT_COLORS = ["default", "red", "green", "blue", "pink"];

const THEME_KEY = "lattix.theme";
const CHAT_KEY = "lattix.chatColor";

const media = typeof matchMedia === "function"
  ? matchMedia("(prefers-color-scheme: light)")
  : null;

/** Stored preference -> the palette actually applied. */
export function resolveTheme(name) {
  if (name === "system") return media && media.matches ? "light" : "dark";
  return THEMES.includes(name) && name !== "system" ? name : "dark";
}

export function applyTheme(name) {
  const stored = THEMES.includes(name) ? name : "dark";
  try { localStorage.setItem(THEME_KEY, stored); } catch (_) {}
  const resolved = resolveTheme(stored);
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  // Tells the UA to render form controls, scrollbars and the canvas behind the
  // page to match — without it a dark page keeps a white flash on overscroll.
  root.style.colorScheme = resolved === "light" ? "light" : "dark";
  updateThemeColorMeta(resolved);
}

export function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || "dark"; } catch (_) { return "dark"; }
}

export function applyChatColor(name) {
  const c = CHAT_COLORS.includes(name) ? name : "default";
  document.documentElement.setAttribute("data-chat", c);
  try { localStorage.setItem(CHAT_KEY, c); } catch (_) {}
}

export function currentChatColor() {
  try { return localStorage.getItem(CHAT_KEY) || "default"; } catch (_) { return "default"; }
}

// Keep the browser UI (mobile address bar, PWA chrome) in step with the theme.
const THEME_COLORS = {
  dark: "#0c0d12", light: "#eef1f7", monokai: "#1e1f1c", kali: "#0a0e14",
};
function updateThemeColorMeta(resolved) {
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);
  }
  meta.setAttribute("content", THEME_COLORS[resolved] || THEME_COLORS.dark);
}

export function initAppearance() {
  applyTheme(currentTheme());
  applyChatColor(currentChatColor());
  // Follow the OS, but only while the user is actually on "system".
  media?.addEventListener?.("change", () => {
    if (currentTheme() === "system") applyTheme("system");
  });
}
