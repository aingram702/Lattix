// Lattix Chrome extension — MV3 service worker.
//
// The extension is a thin shell around the same single-page client the relay
// serves. Clicking the toolbar icon opens (or focuses) the app in a full tab;
// the app itself talks to whichever relay server is configured in Settings
// (defaults to http://localhost:8000 — see js/config.js).

const APP_URL = chrome.runtime.getURL("index.html");

chrome.action.onClicked.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(APP_URL));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: APP_URL });
    }
  } catch (e) {
    await chrome.tabs.create({ url: APP_URL });
  }
});
