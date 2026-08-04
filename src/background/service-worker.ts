chrome.action.onClicked.addListener(() => {
  const editorUrl = chrome.runtime.getURL('editor.html');

  chrome.tabs.query({ url: editorUrl }, tabs => {
    if (tabs.length > 0) {
      // Focus existing tab
      const tabId = tabs[0].id;
      const windowId = tabs[0].windowId;
      if (tabId) {
        chrome.tabs.update(tabId, { active: true });
        if (windowId) {
          chrome.windows.update(windowId, { focused: true });
        }
      }
    } else {
      // Open new tab
      chrome.tabs.create({ url: editorUrl });
    }
  });
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    const editorUrl = chrome.runtime.getURL('editor.html#/welcome');
    chrome.tabs.create({ url: editorUrl });
  }
});
