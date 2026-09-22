// Lattix Chrome extension — MV3 service worker.
//
// The extension is a thin shell around the same single-page client the relay
// serves. Clicking the toolbar icon opens (or focuses) the app in a full tab;
// the app itself talks to whichever relay server is configured in Settings
// (defaults to http://localhost:8000 — change it from the sign-in screen or
// Settings → Relay server; see js/config.js).

const APP_URL = chrome.runtime.getURL("index.html");

/**
 * Find a tab already showing the app.
 *
 * chrome.tabs.query() only populates `tab.url` when the extension holds the
 * "tabs" permission — which would mean reading the address of every tab the
 * user has open. For a messenger that is a far bigger ask than it's worth, so
 * this uses runtime.getContexts() instead: it reports the extension's *own*
 * pages (and their tab ids) with no extra permission at all.
 */
async function findAppTab() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      const ctx = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(APP_URL));
      if (ctx && ctx.tabId != null && ctx.tabId >= 0) {
        // getContexts gives a tab id but no window id; ask for the tab itself.
        return await chrome.tabs.get(ctx.tabId);
      }
    }
  } catch (_) {
    // Older Chrome without getContexts, or the tab went away mid-lookup.
  }
  return null;
}

chrome.action.onClicked.addListener(async () => {
  try {
    const existing = await findAppTab();
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  } catch (_) {
    // Fall through and open a fresh tab.
  }
  try {
    await chrome.tabs.create({ url: APP_URL });
  } catch (_) {
    /* nothing more we can do */
  }
});
