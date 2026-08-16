let isOpening = false;

chrome.action.onClicked.addListener(async () => {
  if (isOpening) return;
  isOpening = true;
  try {
    const editorUrl = chrome.runtime.getURL('editor.html');
    const tabs = await chrome.tabs.query({ url: `${editorUrl}*` });
    if (tabs.length > 0) {
      const tab = tabs.find(t => t.id !== undefined) ?? tabs[0];
      if (tab.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
    } else {
      await chrome.tabs.create({ url: editorUrl });
    }
  } finally {
    isOpening = false;
  }
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    const editorUrl = chrome.runtime.getURL('editor.html#/welcome');
    chrome.tabs.create({ url: editorUrl });
  }
});
