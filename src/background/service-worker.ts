import { TOOLS } from '../core/tools';
import { matchOmniboxTools, omniboxRoute, omniboxText } from '../core/omnibox';
import { NAVIGATE_MESSAGE, type NavigateMessage } from '../core/navigate-message';
import { shouldShowWhatsNew } from '../ui/whats-new/releases';
import { readShownVersion, writeShownVersion } from './whats-new-store';

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
 *
 * GAP-7 reuses the same path for the `pdf` omnibox keyword, with a route: an
 * open editor tab is focused and told to switch tool (a hash change inside the
 * page, so its unsaved documents survive), and only a missing one is created.
 */
let pending: Promise<void> | null = null;

/** How long an editor tab gets to acknowledge a navigate message. */
const NAVIGATE_TIMEOUT_MS = 1000;

/** Asks the editor page in `tabId` to switch route; false if nothing answered. */
async function askTabToNavigate(tabId: number, route: string): Promise<boolean> {
  const message: NavigateMessage = { type: NAVIGATE_MESSAGE, route, tabId };
  const answer = chrome.runtime.sendMessage(message).then(
    (reply: unknown) => reply === true,
    () => false
  );
  const timeout = new Promise<boolean>(resolve =>
    setTimeout(() => resolve(false), NAVIGATE_TIMEOUT_MS)
  );
  return Promise.race([answer, timeout]);
}

async function openEditor(route = '', disposition?: string): Promise<void> {
  const editorUrl = chrome.runtime.getURL('editor.html');
  const targetUrl = route ? `${editorUrl}#${route}` : editorUrl;
  // `tabs.query({ url })` needs the broad `tabs` permission. Extension contexts
  // expose their own tab IDs without that permission, so prefer this MV3 API.
  // `runtime.getContexts` landed in Chrome 116 and Firefox 127, both below the
  // manifests' floors (`scripts/browser-floors.mjs`: Chrome 147, Firefox 144),
  // so it is always present on a supported browser. The guard stays for a
  // sideloaded install on an older one: there the branch is skipped and a fresh
  // tab opens every click, rather than adding the `tabs` permission (see
  // firefox-manifest.test.ts) or silently doing nothing.
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [`${editorUrl}*`]
    });
    const existing = contexts.find(context => context.tabId !== undefined);

    if (existing?.tabId !== undefined) {
      if (route && !(await askTabToNavigate(existing.tabId, route))) {
        // No answer (a page still loading, or one from before an update):
        // navigate the tab itself. Only the fragment differs, so this is a
        // same-document navigation, not a reload.
        await chrome.tabs.update(existing.tabId, { url: targetUrl });
      }
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  }

  // `tabs.create` / `tabs.update` with a URL need no permission. The omnibox's
  // "currentTab" disposition replaces the page the user typed over, as
  // entering any address would.
  if (disposition === 'currentTab') {
    await chrome.tabs.update({ url: targetUrl });
    return;
  }
  await chrome.tabs.create({
    url: targetUrl,
    active: disposition !== 'newBackgroundTab'
  });
}

/** Serialises opens, so two quick triggers never race to create two tabs. */
function openEditorOnce(route?: string, disposition?: string): Promise<void> {
  // Reusing the promise, not just a boolean: a click arriving mid-flight has to
  // resolve with the first one rather than be dropped on the floor.
  if (!pending) {
    pending = openEditor(route, disposition)
      .catch(err => {
        console.error('[stapler] could not open the editor tab', err);
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

chrome.action.onClicked.addListener(() => openEditorOnce());

/*
 * GAP-7 — the `pdf` omnibox keyword ("pdf merge", "pdf compress"). The
 * `omnibox` manifest key is not a permission and adds nothing to the install
 * dialog. Firefox renders descriptions as plain text; Chrome parses them as
 * XML, so only Chrome gets them escaped.
 */
const omnibox = typeof chrome.omnibox === 'object' ? chrome.omnibox : undefined;
const descriptionsAreXml =
  typeof navigator === 'undefined' || !/firefox/i.test(navigator.userAgent ?? '');

if (omnibox) {
  omnibox.setDefaultSuggestion({
    description: omniboxText('Open a Stapler tool — try "merge", "compress" or "sign"', false)
  });

  omnibox.onInputChanged.addListener((text, suggest) => {
    suggest(
      matchOmniboxTools(text, TOOLS).map(tool => ({
        content: tool.id,
        description: omniboxText(`Stapler: ${tool.title} — ${tool.summary}`, descriptionsAreXml)
      }))
    );
  });

  omnibox.onInputEntered.addListener((text, disposition) =>
    openEditorOnce(omniboxRoute(text, TOOLS), disposition)
  );
}

async function showWhatsNewIfDue(previousVersion: string | undefined): Promise<void> {
  const currentVersion = chrome.runtime.getManifest().version;
  const lastShownVersion = await readShownVersion();
  if (
    !shouldShowWhatsNew({ reason: 'update', previousVersion, currentVersion, lastShownVersion })
  ) {
    return;
  }
  // Recorded before the tab opens: a failure after this point costs one
  // missed page, never the same page on every later event.
  await writeShownVersion(currentVersion);
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html#/whats-new') });
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    const editorUrl = chrome.runtime.getURL('editor.html#/welcome');
    chrome.tabs.create({ url: editorUrl });
    return;
  }
  if (details.reason === 'update') {
    return showWhatsNewIfDue(details.previousVersion).catch(err => {
      console.error('[stapler] could not open What’s new', err);
    });
  }
});
