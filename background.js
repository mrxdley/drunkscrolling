class FocusBlockerBackground {
  constructor() {
    this.config = null;
    
    // Per-site time tracking
    this.siteTimeTrackers = new Map(); // siteKey -> { totalElapsedTime, lastResetDate }
    
    // Active session tracking per tab
    this.activeSessions = new Map(); // tabId -> { siteKey, startTime }
    
    // Message queue for tabs without content scripts
    this.messageQueue = new Map(); // tabId -> [messages]
    
    // Current active tab
    this.activeTabId = null;
    
    // Tab blur states
    this.tabBlurStates = new Map(); // tabId -> boolean
    
    // Water break tracking
    this.waterBreakEndTime = null;
    
    // Heartbeat interval
    this.checkInterval = null;
    
    this.initialize();
  }
  
  async initialize() {
    console.log('[Focus Blocker] Background script loaded');
    await this.loadConfig();
    this.setupEventListeners();
    this.checkInitialTab();
  }
  
  async loadConfig() {
    try {
      const response = await fetch(chrome.runtime.getURL('config.json'));
      this.config = await response.json();
      console.log('[Focus Blocker] Config loaded:', this.config);
    } catch (error) {
      console.error('[Focus Blocker] Failed to load config, using defaults:', error);
      this.setDefaultConfig();
    }
  }
  
  setDefaultConfig() {
    this.config = {
      blurrableSites: ['youtube.com'],
      timeoutSeconds: 30,
      blurIntensity: '5px',
      checkIntervalMs: 1000,
      contentCheckIntervalMs: 500,
      enableDebugLogging: true
    };
  }
  
  log(message, ...args) {
    if (this.config?.enableDebugLogging) {
      console.log(`[Focus Blocker] ${message}`, ...args);
    }
  }
  
  getSiteKey(url) {
    if (!url) return null;
    
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const parts = hostname.split('.');
      
      if (parts.length >= 2) {
        return parts.slice(-2).join('.'); // Get main domain (e.g., "youtube.com")
      }
      return hostname;
    } catch {
      return null;
    }
  }
  
  getSiteTimeTracker(siteKey) {
    if (!siteKey) return null;
    
    if (!this.siteTimeTrackers.has(siteKey)) {
      this.siteTimeTrackers.set(siteKey, {
        totalElapsedTime: 0,
        lastResetDate: new Date().toDateString()
      });
    }
    
    const tracker = this.siteTimeTrackers.get(siteKey);
    const today = new Date().toDateString();
    
    if (tracker.lastResetDate !== today) {
      tracker.totalElapsedTime = 0;
      tracker.lastResetDate = today;
      this.log(`Reset daily timer for ${siteKey}`);
    }
    
    return tracker;
  }
  
  isTargetSite(url) {
    if (!url || !this.config) return false;
    
    const siteKey = this.getSiteKey(url);
    if (!siteKey) return false;
    
    return this.config.blurrableSites.some(site => 
      siteKey.includes(site) || site.includes(siteKey)
    );
  }
  
  getTimeoutMs() {
    return (this.config?.timeoutSeconds || 30) * 1000;
  }
  
  getTimeInfoForSite(siteKey) {
    const tracker = this.getSiteTimeTracker(siteKey);
    if (!tracker) return null;
    
    const sessionInfo = this.activeSessions.get(this.activeTabId);
    const sessionElapsed = sessionInfo && sessionInfo.siteKey === siteKey ? 
      Date.now() - sessionInfo.startTime : 0;
    
    const combinedTime = tracker.totalElapsedTime + sessionElapsed;
    const timeoutMs = this.getTimeoutMs();
    
    return {
      totalTime: combinedTime,
      timeoutMs: timeoutMs,
      shouldBeBlurred: combinedTime >= timeoutMs && !this.isWaterBreakActive(),
      dailyTime: tracker.totalElapsedTime
    };
  }
  
  isWaterBreakActive() {
    return this.waterBreakEndTime && Date.now() < this.waterBreakEndTime;
  }
  
  isTabBlurred(tabId) {
    return this.tabBlurStates.get(tabId) === true;
  }
  
  sendMessageToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message)
      .then(response => {
        this.log(`Message sent to tab ${tabId}: ${message.action}`);
        this.updateBlurState(tabId, message.action);
      })
      .catch(error => this.handleSendMessageError(error, tabId, message));
  }
  
  updateBlurState(tabId, action) {
    if (action === 'applyBlur') {
      this.tabBlurStates.set(tabId, true);
    } else if (action === 'removeBlur') {
      this.tabBlurStates.set(tabId, false);
    }
  }
  
  handleSendMessageError(error, tabId, message) {
    if (error.message.includes('Receiving end does not exist')) {
      this.log(`Content script in tab ${tabId} not ready yet, queuing message`);
      if (!this.messageQueue.has(tabId)) {
        this.messageQueue.set(tabId, []);
      }
      this.messageQueue.get(tabId).push(message);
    } else {
      this.log(`Error sending to tab ${tabId}:`, error.message);
    }
  }
  
  startHeartbeat() {
    if (this.checkInterval) clearInterval(this.checkInterval);
    
    const interval = this.config?.checkIntervalMs || 1000;
    this.checkInterval = setInterval(() => this.heartbeatCheck(), interval);
    
    this.log(`Heartbeat started (${interval}ms)`);
  }
  
  heartbeatCheck() {
    if (!this.activeTabId) return;
    
    chrome.tabs.get(this.activeTabId, (tab) => {
      if (tab && tab.url && this.isTargetSite(tab.url) && tab.active) {
        this.checkTabAndApplyBlur(tab);
      }
    });
  }
  
  stopHeartbeat() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.log('Heartbeat stopped');
    }
  }
  
  checkTabAndApplyBlur(tab) {
    if (!tab.active || !this.isTargetSite(tab.url)) return;
    
    const siteKey = this.getSiteKey(tab.url);
    if (!siteKey) return;
    
    if (this.isWaterBreakActive()) {
      if (this.isTabBlurred(tab.id)) {
        this.log(`Water break active, removing blur from ${siteKey}`);
        this.sendMessageToTab(tab.id, { action: 'removeBlur' });
      }
      return;
    }
    
    const timeInfo = this.getTimeInfoForSite(siteKey);
    if (!timeInfo) return;
    
    this.log(`${siteKey}: ${Math.floor(timeInfo.totalTime/1000)}s/${Math.floor(timeInfo.timeoutMs/1000)}s, Blurred: ${this.isTabBlurred(tab.id)}`);
    
    if (timeInfo.shouldBeBlurred) {
      this.handleShouldBeBlurred(tab, siteKey);
    } else {
      this.handleShouldNotBeBlurred(tab, siteKey);
    }
  }
  
  handleShouldBeBlurred(tab, siteKey) {
    if (!this.isTabBlurred(tab.id)) {
      this.log(`${siteKey} - Should be blurred, sending applyBlur`);
      this.sendMessageToTab(tab.id, { 
        action: 'applyBlur',
        blurIntensity: this.config?.blurIntensity || '5px',
        siteKey: siteKey
      });
    }
  }
  
  handleShouldNotBeBlurred(tab, siteKey) {
    if (this.isTabBlurred(tab.id)) {
      this.log(`${siteKey} - Should NOT be blurred, sending removeBlur`);
      this.sendMessageToTab(tab.id, { action: 'removeBlur' });
    }
  }
  
  setupEventListeners() {
    chrome.runtime.onConnect.addListener((port) => this.handlePortConnection(port));
    chrome.tabs.onActivated.addListener((activeInfo) => this.handleTabActivated(activeInfo));
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => this.handleTabUpdated(tabId, changeInfo, tab));
    chrome.windows.onFocusChanged.addListener((windowId) => this.handleWindowFocusChanged(windowId));
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => this.handleRuntimeMessage(message, sender, sendResponse));
  }
  
  handlePortConnection(port) {
    this.log(`Content script connected from tab ${port.sender?.tab?.id}`);
    
    if (port.sender?.tab?.id) {
      const tabId = port.sender.tab.id;
      this.processQueuedMessages(tabId, port);
    }
  }
  
  processQueuedMessages(tabId, port) {
    const queue = this.messageQueue.get(tabId);
    if (queue && queue.length > 0) {
      this.log(`Sending ${queue.length} queued messages to tab ${tabId}`);
      queue.forEach(message => port.postMessage(message));
      this.messageQueue.delete(tabId);
    }
  }
  
  async handleTabActivated(activeInfo) {
    this.log(`Tab activated: ${activeInfo.tabId}`);
    this.activeTabId = activeInfo.tabId;
    const tab = await chrome.tabs.get(activeInfo.tabId);
    this.handleTabChange(tab);
  }
  
  handleTabUpdated(tabId, changeInfo, tab) {
    this.log(`Tab updated: ${tabId}`, changeInfo.url ? 'URL changed' : '');
    
    if (changeInfo.url || changeInfo.status === 'complete') {
      this.tabBlurStates.delete(tabId);
      
      if (this.activeSessions.has(tabId)) {
        this.endActiveSession(tabId);
      }
      
      if (tabId === this.activeTabId) {
        this.handleTabChange(tab);
      }
    }
  }
  
  async handleWindowFocusChanged(windowId) {
    this.log(`Window focus changed: ${windowId}`);
    
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      this.handleNoWindowFocused();
      return;
    }
    
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) {
      this.log(`Active tab in window ${windowId}: ${tab.id}`);
      this.activeTabId = tab.id;
      this.handleTabChange(tab);
    }
  }
  
  handleTabChange(tab) {
    const siteKey = this.getSiteKey(tab.url);
    const isTarget = this.isTargetSite(tab.url);
    const wasActive = this.activeSessions.has(this.activeTabId);
    
    this.log(`Handling tab ${tab.id}:`, {
      siteKey: siteKey,
      isTargetSite: isTarget,
      active: tab.active,
      wasActive: wasActive,
      waterBreakActive: this.isWaterBreakActive()
    });
    
    if (wasActive) {
      this.endActiveSession(this.activeTabId);
    }
    
    if (isTarget && tab.active) {
      this.startNewSession(tab.id, siteKey);
    }
  }
  
  startNewSession(tabId, siteKey) {
    const tracker = this.getSiteTimeTracker(siteKey);
    if (!tracker) return;
    
    this.activeSessions.set(tabId, {
      siteKey: siteKey,
      startTime: Date.now()
    });
    
    this.log(`Starting session for ${siteKey} on tab ${tabId}`);
    this.log(`Current daily time for ${siteKey}: ${Math.floor(tracker.totalElapsedTime/1000)}s`);
    
    this.startHeartbeat();
    
    setTimeout(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab) this.checkTabAndApplyBlur(tab);
      });
    }, 100);
  }
  
  endActiveSession(tabId) {
    const sessionInfo = this.activeSessions.get(tabId);
    if (!sessionInfo) return;
    
    const { siteKey, startTime } = sessionInfo;
    const tracker = this.getSiteTimeTracker(siteKey);
    
    if (tracker) {
      tracker.totalElapsedTime += Date.now() - startTime;
      this.log(`Ended session for ${siteKey}. Total daily: ${Math.floor(tracker.totalElapsedTime/1000)}s`);
    }
    
    this.activeSessions.delete(tabId);
    this.stopHeartbeat();
  }
  
  handleNoWindowFocused() {
    this.log('No Chrome window focused');
    
    if (this.activeTabId) {
      this.endActiveSession(this.activeTabId);
    }
  }
  
  checkInitialTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        this.log('Initial tab check:', tabs[0].id);
        this.activeTabId = tabs[0].id;
        this.handleTabChange(tabs[0]);
      }
    });
  }
  
  handleRuntimeMessage(message, sender, sendResponse) {
    switch (message.action) {
      case 'getTimeStatus':
        this.handleGetTimeStatus(sender, sendResponse);
        break;
      case 'reportBlurState':
        this.handleReportBlurState(message, sender, sendResponse);
        break;
      case 'getConfig':
        this.handleGetConfig(sendResponse);
        break;
      case 'requestWaterBreak':
        this.handleRequestWaterBreak(message, sender, sendResponse);
        break;
      case 'getPopupData':
        this.handleGetPopupData(sendResponse);
        break;
    }
    return true;
  }
  
  handleGetTimeStatus(sender, sendResponse) {
    if (sender.tab && sender.tab.url) {
      const siteKey = this.getSiteKey(sender.tab.url);
      const timeInfo = siteKey ? this.getTimeInfoForSite(siteKey) : null;
      
      if (timeInfo) {
        sendResponse({
          totalTime: timeInfo.totalTime,
          timeoutMs: timeInfo.timeoutMs,
          shouldBeBlurred: timeInfo.shouldBeBlurred,
          blurIntensity: this.config?.blurIntensity || '5px',
          siteKey: siteKey
        });
        return;
      }
    }
    
    sendResponse({
      totalTime: 0,
      timeoutMs: this.getTimeoutMs(),
      shouldBeBlurred: false,
      blurIntensity: this.config?.blurIntensity || '5px',
      siteKey: null
    });
  }
  
  handleReportBlurState(message, sender, sendResponse) {
    if (sender.tab) {
      this.tabBlurStates.set(sender.tab.id, message.isBlurred);
      this.log(`Tab ${sender.tab.id} reported blur state: ${message.isBlurred}`);
    }
    sendResponse({ received: true });
  }
  
  handleGetConfig(sendResponse) {
    sendResponse({
      config: this.config,
      timeoutMs: this.getTimeoutMs()
    });
  }
  
  handleRequestWaterBreak(message, sender, sendResponse) {
    this.waterBreakEndTime = Date.now() + 5000;
    this.log('Water break activated for 5 seconds');
    
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (this.isTabBlurred(tab.id)) {
          this.sendMessageToTab(tab.id, { action: 'removeBlur' });
        }
      });
    });
    
    sendResponse({ success: true });
    
    setTimeout(() => {
      this.waterBreakEndTime = null;
      this.log('Water break ended');
      
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && this.isTargetSite(tab.url)) {
            this.checkTabAndApplyBlur(tab);
          }
        });
      });
    }, 5000);
  }
  
  handleGetPopupData(sendResponse) {
    const getData = (tab) => {
      if (tab && tab.url) {
        const siteKey = this.getSiteKey(tab.url);
        const timeInfo = siteKey ? this.getTimeInfoForSite(siteKey) : null;
        
        const waterBreakActive = this.isWaterBreakActive();
        const waterBreakRemaining = waterBreakActive ? this.waterBreakEndTime - Date.now() : 0;
        
        if (timeInfo) {
          sendResponse({
            totalTime: timeInfo.totalTime,
            timeoutMs: timeInfo.timeoutMs,
            shouldBeBlurred: timeInfo.shouldBeBlurred,
            blurIntensity: this.config?.blurIntensity || '5px',
            config: this.config,
            waterBreakActive: waterBreakActive,
            waterBreakRemaining: waterBreakRemaining,
            currentSite: siteKey,
            dailyTime: timeInfo.dailyTime,
            isTargetSite: this.isTargetSite(tab.url)
          });
          return;
        }
      }
      
      this.sendDefaultPopupData(sendResponse);
    };
    
    if (this.activeTabId) {
      chrome.tabs.get(this.activeTabId, getData);
    } else {
      this.sendDefaultPopupData(sendResponse);
    }
  }
  
  sendDefaultPopupData(sendResponse) {
    const waterBreakActive = this.isWaterBreakActive();
    const waterBreakRemaining = waterBreakActive ? this.waterBreakEndTime - Date.now() : 0;
    
    sendResponse({
      totalTime: 0,
      timeoutMs: this.getTimeoutMs(),
      shouldBeBlurred: false,
      blurIntensity: this.config?.blurIntensity || '5px',
      config: this.config,
      waterBreakActive: waterBreakActive,
      waterBreakRemaining: waterBreakRemaining,
      currentSite: null,
      dailyTime: 0,
      isTargetSite: false
    });
  }
}

// Initialize the extension
new FocusBlockerBackground();