class FocusBlockerContent {
  constructor() {
    this.blurApplied = false;
    this.heartbeatInterval = null;
    this.config = null;
    this.blurIntensity = '5px';
    
    this.blurChance = 0.9;
    this.blurMin = 4;
    this.blurMax = 10;
    this.blurCheckInterval = 100;
    
    this.lastBlurCheck = 0;
    this.currentBlurLevel = 0;
    this.targetBlurLevel = 0;
    this.blurAnimationId = null;

    this.currentSiteKey = null;
    
    this.initialize();
  }
  
  async initialize() {
    console.log('[Focus Blocker] Content script loaded');
    
    await this.loadConfig();
    this.connectToBackground();
    this.setupEventListeners();
    this.setupMutationObserver();
    this.startContentHeartbeat();
  }
  
  async loadConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
      if (response?.config) {
        this.config = response.config;
        this.blurIntensity = this.config.blurIntensity || '5px';
        
        this.blurChance = this.config.blurChance ?? 0.9;
        this.blurMin = this.config.blurMin ?? 4;
        this.blurMax = this.config.blurMax ?? 10;
        this.blurCheckInterval = this.config.blurCheckInterval || 100;
        
        console.log('[Focus Blocker] Blur effect config loaded:', {
          chance: this.blurChance,
          min: this.blurMin,
          max: this.blurMax,
          checkInterval: this.blurCheckInterval
        });
      }
    } catch (error) {
      console.error('[Focus Blocker] Failed to load config:', error);
    }
  }
  
  connectToBackground() {
    this.port = chrome.runtime.connect({ name: 'content-script' });
    console.log('[Focus Blocker] Connected to background script');
    
    this.reportBlurState(false);
  }
  
  reportBlurState(isBlurred) {
    chrome.runtime.sendMessage({ 
      action: 'reportBlurState', 
      isBlurred: isBlurred 
    });
  }
  
  getRandomBlurIntensity() {
    return Math.random() * (this.blurMax - this.blurMin) + this.blurMin + 'px';
  }
  
  animateBlur() {
    if (this.currentBlurLevel === this.targetBlurLevel) {
      this.stopAnimation();
      return;
    }
    
    const diff = this.targetBlurLevel - this.currentBlurLevel;
    this.currentBlurLevel += diff * 0.1; // 10% per frame for smooth transition
    
    this.applyBlurToPage(this.currentBlurLevel + 'px');
    
    this.blurAnimationId = requestAnimationFrame(() => this.animateBlur());
  }
  
  stopAnimation() {
    if (this.blurAnimationId) {
      cancelAnimationFrame(this.blurAnimationId);
      this.blurAnimationId = null;
    }
  }
  
  applyBlurToPage(intensity) {
    document.body.style.filter = `blur(${intensity})`;
    document.body.style.webkitFilter = `blur(${intensity})`;
    
    document.querySelectorAll('iframe, video').forEach(element => {
      element.style.filter = `blur(${intensity})`;
      element.style.webkitFilter = `blur(${intensity})`;
    });
  }
  
  applyBlur() {
    const now = Date.now();
    
    if (now - this.lastBlurCheck < this.blurCheckInterval) {
      return;
    }
    this.lastBlurCheck = now;
    
    if (Math.random() > this.blurChance) {
      console.log('[Focus Blocker] Random skip - no blur this time');
      return;
    }
    
    const newTargetBlur = parseFloat(this.getRandomBlurIntensity());
    if (this.targetBlurLevel !== newTargetBlur || !this.blurAnimationId) {
      this.targetBlurLevel = newTargetBlur;
      
      if (!this.blurAnimationId) {
        this.blurAnimationId = requestAnimationFrame(() => this.animateBlur());
      }
      
      this.blurApplied = true;
      console.log(`[Focus Blocker] Blur animating to ${this.targetBlurLevel}px`);
      
      this.reportBlurState(true);
    }
  }
  
  removeBlur() {
    if (!this.blurApplied) return;
    
    this.targetBlurLevel = 0;
    
    if (!this.blurAnimationId) {
      this.blurAnimationId = requestAnimationFrame(() => this.animateBlur());
    }
    
    setTimeout(() => {
      if (this.targetBlurLevel === 0 && Math.abs(this.currentBlurLevel) < 0.1) {
        this.blurApplied = false;
        console.log('[Focus Blocker] Blur fully removed');
        this.reportBlurState(false);
      }
    }, 300);
    
    console.log('[Focus Blocker] Blur fading out');
  }
  
  startContentHeartbeat() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      this.startHeartbeat();
    } else {
      window.addEventListener('DOMContentLoaded', () => this.startHeartbeat());
    }
    
    this.performInitialCheck();
  }
  
  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    
    const interval = this.config?.contentCheckIntervalMs || 500;
    this.heartbeatInterval = setInterval(() => this.heartbeatCheck(), interval);
    
    console.log(`[Focus Blocker] Content heartbeat started (${interval}ms)`);
  }
  
  heartbeatCheck() {
    chrome.runtime.sendMessage({ action: 'getTimeStatus' }, (response) => {
      if (chrome.runtime.lastError) return;
      
      // Store site key for debugging
      if (response?.siteKey && response.siteKey !== this.currentSiteKey) {
        this.currentSiteKey = response.siteKey;
        console.log(`[Focus Blocker] Now on site: ${this.currentSiteKey}`);
      }
      
      // Check if water break is active
      chrome.runtime.sendMessage({ action: 'getPopupData' }, (popupData) => {
        if (popupData?.waterBreakActive) {
          if (this.blurApplied) {
            console.log(`[Focus Blocker] Water break active, removing blur from ${this.currentSiteKey}`);
            this.removeBlur();
          }
          return;
        }
        
        if (response?.shouldBeBlurred && !this.blurApplied) {
          console.log(`[Focus Blocker] ${this.currentSiteKey} - Should be blurred (total: ${Math.floor(response.totalTime/1000)}s), applying`);
          this.applyBlur();
        } else if (response && !response.shouldBeBlurred && this.blurApplied) {
          console.log(`[Focus Blocker] ${this.currentSiteKey} - Should NOT be blurred (total: ${Math.floor(response.totalTime/1000)}s), removing`);
          this.removeBlur();
        }
        
        this.verifyBlurState();
      });
    });
  }
  
  verifyBlurState() {
    if (this.blurApplied && document.body.style.filter !== `blur(${this.blurIntensity})`) {
      console.log('[Focus Blocker] Heartbeat - Blur was removed, reapplying');
      this.applyBlur();
    }
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[Focus Blocker] Content heartbeat stopped');
    }
  }
  
  performInitialCheck() {
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'getTimeStatus' }, (response) => {
        if (response?.shouldBeBlurred) {
          if (response.blurIntensity) {
            this.blurIntensity = response.blurIntensity;
          }
          console.log(`[Focus Blocker] Initial check - Should be blurred (total: ${Math.floor(response.totalTime/1000)}s)`);
          this.applyBlur();
        }
      });
    }, 1000);
  }
  
  setupEventListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => this.handleRuntimeMessage(message, sender, sendResponse));
    
    if (this.port) {
      this.port.onMessage.addListener((message) => this.handlePortMessage(message));
      this.port.onDisconnect.addListener(() => this.handlePortDisconnect());
    }
    
    window.addEventListener('beforeunload', () => this.stopHeartbeat());
  }
  
  handleRuntimeMessage(message, sender, sendResponse) {
    console.log(`[Focus Blocker] Received message: ${message.action}`);
    
    switch (message.action) {
      case 'applyBlur':
        if (message.blurIntensity) {
          this.blurIntensity = message.blurIntensity;
        }
        this.applyBlur();
        break;
      case 'removeBlur':
        this.removeBlur();
        break;
    }
    
    sendResponse({ received: true });
    return true;
  }
  
  handlePortMessage(message) {
    console.log(`[Focus Blocker] Received port message: ${message.action}`);
    
    switch (message.action) {
      case 'applyBlur':
        if (message.blurIntensity) {
          this.blurIntensity = message.blurIntensity;
        }
        this.applyBlur();
        break;
      case 'removeBlur':
        this.removeBlur();
        break;
    }
  }
  
  handlePortDisconnect() {
    console.log('[Focus Blocker] Disconnected from background');
    this.stopHeartbeat();
  }
  
  setupMutationObserver() {
    const observer = new MutationObserver(() => this.handleDOMChanges());
    
    observer.observe(document, { 
      childList: true, 
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'id']
    });
    
    console.log('[Focus Blocker] Mutation observer ready');
  }
  
  handleDOMChanges() {
    if (!this.blurApplied) return;
    
    setTimeout(() => {
      if (this.blurApplied && document.body.style.filter !== `blur(${this.blurIntensity})`) {
        console.log('[Focus Blocker] Mutation - Blur was removed, reapplying');
        this.applyBlur();
      }
    }, 10);
  }
}

// Initialize the content script
new FocusBlockerContent();