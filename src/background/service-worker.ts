/**
 * The toolbar button: focus the editor tab if one is open, otherwise open one.
 *
 * Two things this guards, both from AUDIT-FINDINGS §4:
 *
 *  - `chrome.tabs.query` is async, so two clicks landing before the first
 *    resolves both saw "no editor tab" and both opened one. `pending` holds the
 *    in-flight promise so the second click joins it instead of racing it.
 *  - A tab with no `id` (Chrome omits it for tabs in a devtools window or one
 *    being discarded) used to fall through every branch and do nothing at all:
 *    the user clicked the icon and the extension appeared broken. It now opens
 *    a fresh editor tab, which is the thing they asked for.
 */
let pending: Promise<void> | null = null;

async function openEditor(): Promise<void> {
  const editorUrl = chrome.runtime.getURL('editor.html');
  // `tabs.query({ url })` needs the broad `tabs` permission. Extension contexts
  // expose their own tab IDs without that permission, so prefer this MV3 API.
  // `runtime.getContexts` only landed in Firefox 127 (our manifest's
  // `strict_min_version` is 109.0, and we deliberately don't add the `tabs`
  // permission there either — see firefox-manifest.test.ts), so on an older
  // Firefox this branch is skipped and a fresh tab opens every click instead
  // of silently doing nothing, which is what happened before this existed.
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [`${editorUrl}*`]
    });
    const existing = contexts.find(context => context.tabId !== undefined);

    if (existing?.tabId !== undefined) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  }

  await chrome.tabs.create({ url: editorUrl });
}

chrome.action.onClicked.addListener(() => {
  // Reusing the promise, not just a boolean: a click arriving mid-flight has to
  // resolve with the first one rather than be dropped on the floor.
  if (!pending) {
    pending = openEditor()
      .catch(err => {
        console.error('[stapler] could not open the editor tab', err);
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    const editorUrl = chrome.runtime.getURL('editor.html#/welcome');
    chrome.tabs.create({ url: editorUrl });
  }
});
