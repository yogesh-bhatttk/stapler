chrome.action.onClicked.addListener(async () => {
  const editorUrl = chrome.runtime.getURL('editor.html');
  const tabs = await chrome.tabs.query({ url: `${editorUrl}*` });
  if (tabs.length > 0) {
    const tabId = tabs[0].id;
    const windowId = tabs[0].windowId;
    if (tabId) {
      await chrome.tabs.update(tabId, { active: true });
      if (windowId) {
        await chrome.windows.update(windowId, { focused: true });
      }
    }
  } else {
    await chrome.tabs.create({ url: editorUrl });
  }
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    const editorUrl = chrome.runtime.getURL('editor.html#/welcome');
    chrome.tabs.create({ url: editorUrl });
  }
});
