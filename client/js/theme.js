// Lattix — appearance (theme + chat color) persistence.

export const THEMES = ["dark", "light", "monokai", "kali"];
export const CHAT_COLORS = ["default", "red", "green", "blue", "pink"];

export function applyTheme(name) {
  const t = THEMES.includes(name) ? name : "dark";
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("lattix.theme", t);
}
export function currentTheme() {
  return localStorage.getItem("lattix.theme") || "dark";
}

export function applyChatColor(name) {
  const c = CHAT_COLORS.includes(name) ? name : "default";
  document.documentElement.setAttribute("data-chat", c);
  localStorage.setItem("lattix.chatColor", c);
}
export function currentChatColor() {
  return localStorage.getItem("lattix.chatColor") || "default";
}

// Apply persisted appearance as early as possible to avoid a flash.
export function initAppearance() {
  applyTheme(currentTheme());
  applyChatColor(currentChatColor());
}
