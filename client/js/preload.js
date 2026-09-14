// Lattix — theme bootstrap, before first paint.
//
// js/app.js is a module and therefore deferred, so without this the page
// paints once with the default dark palette before the stored theme is
// applied — a visible flash for anyone on light, monokai or kali.
//
// This is a separate file rather than an inline <script> on purpose: the
// Chrome MV3 extension's content security policy forbids inline script, and
// the client is loaded both as a web page and as an extension.
//
// Mirrors resolveTheme() in js/theme.js — keep the two in step.
(function () {
  try {
    var stored = localStorage.getItem("lattix.theme") || "dark";
    var resolved = stored === "system"
      ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : stored;
    if (["dark", "light", "monokai", "kali"].indexOf(resolved) === -1) resolved = "dark";

    var root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-chat", localStorage.getItem("lattix.chatColor") || "default");
    root.style.colorScheme = resolved === "light" ? "light" : "dark";
  } catch (e) {
    // Private mode, blocked storage, no matchMedia — fall back to the default
    // palette rather than breaking the page.
  }
})();
