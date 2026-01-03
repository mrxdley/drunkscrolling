let blurApplied = false;
let heartbeatInterval = null;
let config = null;
let blurIntensity = '5px';

console.log('[Focus Blocker] Content script loaded');

// Update loadConfig to read new settings
async function loadConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
    if (response && response.config) {
      config = response.config;
      blurIntensity = config.blurIntensity || '5px';
      
      // Read new blur effect settings
      blurChance = config.blurChance !== undefined ? config.blurChance : 0.9;
      blurMin = config.blurMin !== undefined ? config.blurMin : 4;
      blurMax = config.blurMax !== undefined ? config.blurMax : 10;
      blurCheckInterval = config.blurCheckInterval || 100;
      
      console.log('[Focus Blocker] Blur effect config loaded:', {
        chance: blurChance,
        min: blurMin,
        max: blurMax,
        checkInterval: blurCheckInterval
      });
    }
  } catch (error) {
    console.error('[Focus Blocker] Failed to load config:', error);
  }
}
// Connect to background script
const port = chrome.runtime.connect({ name: 'content-script' });
console.log('[Focus Blocker] Connected to background script');

// Report initial blur state
chrome.runtime.sendMessage({ 
  action: 'reportBlurState', 
  isBlurred: false 
});

let lastBlurCheck = 0;
let currentBlurLevel = 0;
let targetBlurLevel = 0;
let blurAnimationId = null;
let blurChance = 0.9; // 90% default
let blurMin = 4;
let blurMax = 10;
let blurCheckInterval = 100;

// Function to get random blur intensity
function getRandomBlurIntensity() {
  return Math.random() * (blurMax - blurMin) + blurMin + 'px';
}

// Function to smoothly animate blur
function animateBlur() {
  if (currentBlurLevel === targetBlurLevel) {
    if (blurAnimationId) {
      cancelAnimationFrame(blurAnimationId);
      blurAnimationId = null;
    }
    return;
  }

  // Smooth interpolation (easing)
  const diff = targetBlurLevel - currentBlurLevel;
  currentBlurLevel += diff * 0.1; // 10% per frame for smooth transition
  
  // Apply the current blur level
  const intensity = currentBlurLevel + 'px';
  document.body.style.filter = `blur(${intensity})`;
  document.body.style.webkitFilter = `blur(${intensity})`;
  
  // Also blur any iframes and videos
  document.querySelectorAll('iframe, video').forEach(el => {
    el.style.filter = `blur(${intensity})`;
    el.style.webkitFilter = `blur(${intensity})`;
  });
  
  // Continue animation
  blurAnimationId = requestAnimationFrame(animateBlur);
}

// Updated applyBlurForce function with random chance and smooth animation
function applyBlurForce() {
  const now = Date.now();
  
  // Throttle blur checks
  if (now - lastBlurCheck < blurCheckInterval) {
    return;
  }
  lastBlurCheck = now;
  
  // Random chance check
  if (Math.random() > blurChance) {
    console.log(`[Focus Blocker] Random skip - no blur this time`);
    return;
  }
  
  // Only start new animation if we're not already at target or animating
  const newTargetBlur = parseFloat(getRandomBlurIntensity());
  if (targetBlurLevel !== newTargetBlur || !blurAnimationId) {
    targetBlurLevel = newTargetBlur;
    
    // Start animation if not already running
    if (!blurAnimationId) {
      blurAnimationId = requestAnimationFrame(animateBlur);
    }
    
    blurApplied = true;
    console.log(`[Focus Blocker] Blur animating to ${targetBlurLevel}px`);
    
    // Report blur state to background
    chrome.runtime.sendMessage({ 
      action: 'reportBlurState', 
      isBlurred: true 
    });
  }
}

// Updated removeBlur function with smooth fade-out
function removeBlur() {
  if (blurApplied) {
    targetBlurLevel = 0;
    
    // Start fade-out animation if not already running
    if (!blurAnimationId) {
      blurAnimationId = requestAnimationFrame(animateBlur);
    }
    
    // Mark as not applied when animation completes
    setTimeout(() => {
      if (targetBlurLevel === 0 && Math.abs(currentBlurLevel) < 0.1) {
        blurApplied = false;
        console.log('[Focus Blocker] Blur fully removed');
        
        // Report blur state to background
        chrome.runtime.sendMessage({ 
          action: 'reportBlurState', 
          isBlurred: false 
        });
      }
    }, 300); // Check after animation time
    
    console.log('[Focus Blocker] Blur fading out');
  }
}

// HEARTBEAT: Check at configured interval
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  
  const interval = config?.contentCheckIntervalMs || 500;
  heartbeatInterval = setInterval(() => {
    // Ask background for current time status
    chrome.runtime.sendMessage({ action: 'getTimeStatus' }, (response) => {
      if (chrome.runtime.lastError) return;
      
      if (response && response.shouldBeBlurred && !blurApplied) {
        console.log(`[Focus Blocker] Heartbeat - Should be blurred (total: ${Math.floor(response.totalTime/1000)}s), applying`);
        applyBlurForce();
      } else if (response && !response.shouldBeBlurred && blurApplied) {
        console.log(`[Focus Blocker] Heartbeat - Should NOT be blurred (total: ${Math.floor(response.totalTime/1000)}s), removing`);
        removeBlur();
      }
      // Note: No log for already blurred state to reduce spam
    });
    
    // Also force reapply blur if it should be applied
    if (blurApplied) {
      // Quick check to ensure blur is still applied
      const intensity = blurIntensity;
      if (document.body.style.filter !== `blur(${intensity})`) {
        console.log('[Focus Blocker] Heartbeat - Blur was removed, reapplying');
        applyBlurForce();
      }
    }
  }, interval);
  
  console.log(`[Focus Blocker] Content heartbeat started (${interval}ms)`);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[Focus Blocker] Content heartbeat stopped');
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`[Focus Blocker] Received message: ${message.action}`);
  
  if (message.action === 'applyBlur') {
    if (message.blurIntensity) {
      blurIntensity = message.blurIntensity;
    }
    applyBlurForce();
  } else if (message.action === 'removeBlur') {
    removeBlur();
  }
  
  sendResponse({ received: true });
  return true;
});

port.onMessage.addListener((message) => {
  console.log(`[Focus Blocker] Received port message: ${message.action}`);
  
  if (message.action === 'applyBlur') {
    if (message.blurIntensity) {
      blurIntensity = message.blurIntensity;
    }
    applyBlurForce();
  } else if (message.action === 'removeBlur') {
    removeBlur();
  }
});

// Handle SPA navigation
const observer = new MutationObserver((mutations) => {
  // If we should be blurred, make sure it stays
  if (blurApplied) {
    // Quick reapply
    setTimeout(() => {
      const intensity = blurIntensity;
      if (blurApplied && document.body.style.filter !== `blur(${intensity})`) {
        console.log('[Focus Blocker] Mutation - Blur was removed, reapplying');
        applyBlurForce();
      }
    }, 10);
  }
});

// Start observing
observer.observe(document, { 
  childList: true, 
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'class', 'id']
});

console.log('[Focus Blocker] Mutation observer ready');

// Initialize
loadConfig().then(() => {
  // Start heartbeat when page is ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log('[Focus Blocker] Page ready, starting heartbeat');
    startHeartbeat();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      console.log('[Focus Blocker] DOM loaded, starting heartbeat');
      startHeartbeat();
    });
    
    window.addEventListener('load', () => {
      console.log('[Focus Blocker] Page fully loaded');
    });
  }
  
  // Check immediately on load
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'getTimeStatus' }, (response) => {
      if (response && response.shouldBeBlurred) {
        if (response.blurIntensity) {
          blurIntensity = response.blurIntensity;
        }
        console.log(`[Focus Blocker] Initial check - Should be blurred (total: ${Math.floor(response.totalTime/1000)}s)`);
        applyBlurForce();
      }
    });
  }, 1000);
});

// Clean up
port.onDisconnect.addListener(() => {
  console.log('[Focus Blocker] Disconnected from background');
  stopHeartbeat();
});

// Also clean up on page unload
window.addEventListener('beforeunload', () => {
  stopHeartbeat();
});