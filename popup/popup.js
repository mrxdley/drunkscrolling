class FocusBlockerPopup {
  constructor() {
    this.waterBreakDuration = 5000; // 5 seconds in milliseconds
    this.waterBreakEndTime = null;
    this.updateInterval = null;
    
    this.initialize();
  }
  
  initialize() {
    console.log('[Focus Blocker] Popup script loaded');
    
    this.cacheElements();
    this.setupEventListeners();
    this.startUpdateLoop();
  }
  
  cacheElements() {
    this.timeUntilBlurElement = document.getElementById('timeUntilBlur');
    this.waterButton = document.getElementById('waterButton');
    this.totalTimeTodayElement = document.getElementById('totalTimeToday');
    this.blockedSitesCountElement = document.getElementById('blockedSitesCount');
    this.currentStatusElement = document.getElementById('currentStatus');
    this.errorMessageElement = document.getElementById('errorMessage');
  }
  
  setupEventListeners() {
    this.waterButton.addEventListener('click', () => this.handleWaterButtonClick());
  }
  
  async handleWaterButtonClick() {
    try {
      await this.requestWaterBreak();
      this.startWaterBreakCooldown();
    } catch (error) {
      console.error('[Focus Blocker] Error requesting water break:', error);
      this.showError('Failed to request water break');
    }
  }
  
  async requestWaterBreak() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'requestWaterBreak' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response?.success) {
          resolve(response);
        } else {
          reject(new Error('Water break request failed'));
        }
      });
    });
  }
  
  startWaterBreakCooldown() {
    this.waterBreakEndTime = Date.now() + this.waterBreakDuration;
    this.waterButton.disabled = true;
    this.updateWaterButtonText();
  }
  
  updateWaterButtonText() {
    if (!this.waterButton.disabled) {
      this.waterButton.textContent = '💧 Water Break';
      return;
    }
    
    const remainingTime = Math.max(0, this.waterBreakEndTime - Date.now());
    const seconds = Math.ceil(remainingTime / 1000);
    
    if (seconds > 0) {
      this.waterButton.textContent = `⏳ ${seconds}s`;
    } else {
      this.waterBreakEndTime = null;
      this.waterButton.disabled = false;
      this.waterButton.textContent = '💧 Water Break';
    }
  }
  
  startUpdateLoop() {
    // Update immediately
    this.updatePopupData();
    
    // Then update every second
    this.updateInterval = setInterval(() => {
      this.updatePopupData();
      this.updateWaterButtonText();
    }, 1000);
  }
  
  async updatePopupData() {
    try {
      const data = await this.getTimeStatus();
      this.updateUI(data);
      this.hideError();
    } catch (error) {
      console.error('[Focus Blocker] Error updating popup data:', error);
      this.showError('Cannot connect to extension');
    }
  }
  
  async getTimeStatus() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getPopupData' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response) {
          resolve(response);
        } else {
          reject(new Error('No response from background script'));
        }
      });
    });
  }
  
  updateUI(data) {
    this.updateTimeUntilBlur(data);
    this.updateTotalTime(data);
    this.updateStatus(data);
  }
  
  updateTimeUntilBlur(data) {
    if (data.waterBreakActive) {
      const remaining = Math.max(0, data.waterBreakRemaining);
      const seconds = Math.ceil(remaining / 1000);
      this.timeUntilBlurElement.textContent = `${seconds}s`;
      this.timeUntilBlurElement.style.color = '#4CAF50';
    } else {
      const timeLeft = Math.max(0, data.timeoutMs - data.totalTime);
      const seconds = Math.ceil(timeLeft / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      
      if (timeLeft <= 0) {
        this.timeUntilBlurElement.textContent = 'BLURRED';
        this.timeUntilBlurElement.style.color = '#F44336';
      } else {
        this.timeUntilBlurElement.textContent = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
        this.timeUntilBlurElement.style.color = '#2196F3';
      }
    }
  }
  
  updateTotalTime(data) {
    const totalSeconds = Math.floor(data.totalTime / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.totalTimeTodayElement.textContent = `${minutes}m ${seconds}s`;
  }
  
  updateStatus(data) {
    if (data.waterBreakActive) {
      this.currentStatusElement.textContent = 'Water Break';
      this.currentStatusElement.style.color = '#4CAF50';
    } else if (data.totalTime >= data.timeoutMs) {
      this.currentStatusElement.textContent = 'Blurred';
      this.currentStatusElement.style.color = '#F44336';
    } else {
      this.currentStatusElement.textContent = 'Active';
      this.currentStatusElement.style.color = '#2196F3';
    }
  }
  
  showError(message) {
    if (this.errorMessageElement) {
      this.errorMessageElement.textContent = message;
      this.errorMessageElement.style.display = 'block';
    }
  }
  
  hideError() {
    if (this.errorMessageElement) {
      this.errorMessageElement.style.display = 'none';
    }
  }
  
  cleanup() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

// Initialize the popup
new FocusBlockerPopup();

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (window.focusBlockerPopup) {
    window.focusBlockerPopup.cleanup();
  }
});