let config = null;
let totalElapsedTime = 0; // Never resets
let sessionStartTime = null;
let isTargetSiteActive = false;
let messageQueue = new Map();
let activeTabId = null;
let checkInterval = null;
let tabBlurStates = new Map();

console.log('[Focus Blocker] Background script loaded');

// Load configuration
async function loadConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL('config.json'));
    config = await response.json();
    console.log('[Focus Blocker] Config loaded:', config);
  } catch (error) {
    console.error('[Focus Blocker] Failed to load config, using defaults:', error);
    // Default fallback config
    config = {
      blurrableSites: ['youtube.com'],
      timeoutSeconds: 30,
      blurIntensity: '5px',
      checkIntervalMs: 1000,
      contentCheckIntervalMs: 500,
      enableDebugLogging: true
    };
  }
}

// Initialize
loadConfig();

function log(message, ...args) {
  if (config?.enableDebugLogging) {
    console.log(`[Focus Blocker] ${message}`, ...args);
  }
}

function isTargetSite(url) {
  if (!url || !config) return false;
  
  try {
    const urlObj = new URL(url);
    return config.blurrableSites.some(site => urlObj.hostname.includes(site));
  } catch {
    return false;
  }
}

function getTimeoutMs() {
  return (config?.timeoutSeconds || 30) * 1000;
}

function sendMessageToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message)
    .then(response => {
      log(`Message sent to tab ${tabId}: ${message.action}`);
      
      // Update blur state tracking
      if (message.action === 'applyBlur') {
        tabBlurStates.set(tabId, true);
      } else if (message.action === 'removeBlur') {
        tabBlurStates.set(tabId, false);
      }
    })
    .catch(error => {
      if (error.message.includes('Receiving end does not exist')) {
        log(`Content script in tab ${tabId} not ready yet, queuing message`);
        if (!messageQueue.has(tabId)) {
          messageQueue.set(tabId, []);
        }
        messageQueue.get(tabId).push(message);
      } else {
        log(`Error sending to tab ${tabId}:`, error.message);
      }
    });
}

function isTabBlurred(tabId) {
  return tabBlurStates.get(tabId) === true;
}

// HEARTBEAT: Check at configured interval
function startHeartbeat() {
  if (checkInterval) clearInterval(checkInterval);
  
  const interval = config?.checkIntervalMs || 1000;
  checkInterval = setInterval(() => {
    if (activeTabId) {
      chrome.tabs.get(activeTabId, (tab) => {
        if (tab && tab.url && isTargetSite(tab.url) && tab.active) {
          checkTabAndApplyBlur(tab);
        }
      });
    }
  }, interval);
  
  log(`Heartbeat started (${interval}ms)`);
}

function stopHeartbeat() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    log('Heartbeat stopped');
  }
}

function checkTabAndApplyBlur(tab) {
  if (!tab.active || !isTargetSite(tab.url)) return;
  
  const timeoutMs = getTimeoutMs();
  
  if (sessionStartTime) {
    const sessionElapsed = Date.now() - sessionStartTime;
    const combinedTime = totalElapsedTime + sessionElapsed;
    
    log(`Heartbeat - Total: ${Math.floor(combinedTime/1000)}s, Tab blurred: ${isTabBlurred(tab.id)}`);
    
    // Check if we should be blurred
    if (combinedTime >= timeoutMs) {
      // Only send applyBlur if tab isn't already blurred
      if (!isTabBlurred(tab.id)) {
        log(`Heartbeat - Should be blurred, sending applyBlur`);
        sendMessageToTab(tab.id, { 
          action: 'applyBlur',
          blurIntensity: config?.blurIntensity || '5px'
        });
      } else {
        log(`Heartbeat - Already blurred, skipping`);
      }
    } else {
      // Only send removeBlur if tab is currently blurred
      if (isTabBlurred(tab.id)) {
        log(`Heartbeat - Should NOT be blurred, sending removeBlur`);
        sendMessageToTab(tab.id, { action: 'removeBlur' });
      }
    }
  } else if (totalElapsedTime >= timeoutMs) {
    // Already crossed threshold in past sessions
    if (!isTabBlurred(tab.id)) {
      log(`Heartbeat - Already past timeout, forcing blur`);
      sendMessageToTab(tab.id, { 
        action: 'applyBlur',
        blurIntensity: config?.blurIntensity || '5px'
      });
    } else {
      log(`Heartbeat - Already past timeout and already blurred, skipping`);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  log(`Content script connected from tab ${port.sender?.tab?.id}`);
  
  if (port.sender?.tab?.id) {
    const tabId = port.sender.tab.id;
    const queue = messageQueue.get(tabId);
    
    if (queue && queue.length > 0) {
      log(`Sending ${queue.length} queued messages to tab ${tabId}`);
      queue.forEach(message => {
        port.postMessage(message);
      });
      messageQueue.delete(tabId);
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  log(`Tab activated: ${activeInfo.tabId}`);
  activeTabId = activeInfo.tabId;
  const tab = await chrome.tabs.get(activeInfo.tabId);
  handleTabChange(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  log(`Tab updated: ${tabId}`, changeInfo.url ? `URL changed` : '');
  if (changeInfo.url || changeInfo.status === 'complete') {
    // Reset blur state on URL change (new page)
    tabBlurStates.delete(tabId);
    
    if (tabId === activeTabId) {
      handleTabChange(tab);
    }
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  log(`Window focus changed: ${windowId}`);
  
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    log('No Chrome window focused');
    if (isTargetSiteActive && sessionStartTime) {
      totalElapsedTime += Date.now() - sessionStartTime;
      sessionStartTime = null;
      isTargetSiteActive = false;
      log(`Paused. Total time: ${Math.floor(totalElapsedTime/1000)}s`);
      stopHeartbeat();
    }
    return;
  }
  
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) {
    log(`Active tab in window ${windowId}: ${tab.id}`);
    activeTabId = tab.id;
    handleTabChange(tab);
  }
});

function handleTabChange(tab) {
  const isTarget = isTargetSite(tab.url);
  const wasTargetSiteActive = isTargetSiteActive;
  
  log(`Handling tab ${tab.id}:`, {
    isTargetSite: isTarget,
    active: tab.active,
    wasTargetSiteActive: wasTargetSiteActive,
    totalElapsedTime: Math.floor(totalElapsedTime/1000) + 's'
  });
  
  if (isTarget && tab.active) {
    // Start or continue session
    if (!wasTargetSiteActive) {
      sessionStartTime = Date.now();
      isTargetSiteActive = true;
      log(`Starting/resuming timer for tab ${tab.id}`);
      log(`Current total: ${Math.floor(totalElapsedTime/1000)}s`);
      
      startHeartbeat();
      
      // Immediate check
      setTimeout(() => {
        checkTabAndApplyBlur(tab);
      }, 100);
    }
  } else if (wasTargetSiteActive) {
    // Target site lost focus - save session time
    if (sessionStartTime) {
      totalElapsedTime += Date.now() - sessionStartTime;
      sessionStartTime = null;
    }
    isTargetSiteActive = false;
    log(`Target site lost focus. Saved time. Total: ${Math.floor(totalElapsedTime/1000)}s`);
    stopHeartbeat();
  }
}

// Check initial tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    log('Initial tab check:', tabs[0].id);
    activeTabId = tabs[0].id;
    handleTabChange(tabs[0]);
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTimeStatus') {
    const sessionElapsed = sessionStartTime ? Date.now() - sessionStartTime : 0;
    const combinedTime = totalElapsedTime + sessionElapsed;
    const timeoutMs = getTimeoutMs();
    
    sendResponse({
      totalTime: combinedTime,
      timeoutMs: timeoutMs,
      shouldBeBlurred: combinedTime >= timeoutMs,
      blurIntensity: config?.blurIntensity || '5px'
    });
    return true;
  } else if (message.action === 'reportBlurState') {
    // Content script reports its blur state
    if (sender.tab) {
      tabBlurStates.set(sender.tab.id, message.isBlurred);
      log(`Tab ${sender.tab.id} reported blur state: ${message.isBlurred}`);
    }
    sendResponse({ received: true });
    return true;
  } else if (message.action === 'getConfig') {
    // Send config to content script
    sendResponse({
      config: config,
      timeoutMs: getTimeoutMs()
    });
    return true;
  }
});