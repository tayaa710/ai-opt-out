// Placeholder, replaced by the core background implementation.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  sendResponse({ ok: false, error: `Not implemented: ${msg?.type}` });
});
