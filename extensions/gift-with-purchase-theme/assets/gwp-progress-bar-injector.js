// GWP Progress Bar Injector
// Dynamically injects the progress bar based on CSS selector configuration

(function() {
  'use strict';

  // Configuration from admin settings
  let gwpConfig = null;
  let progressBarConfig = null;

  // Initialize the progress bar injector
  function init() {
    console.log('🎁 GWP Progress Bar Injector: Initializing...');
    
    // Load configuration from the public API
    loadConfig().then(() => {
      if (progressBarConfig && progressBarConfig.enabled && progressBarConfig.selector) {
        console.log('🎁 GWP Progress Bar Injector: Config loaded, attempting to inject progress bar');
        injectProgressBar();
      } else {
        console.log('🎁 GWP Progress Bar Injector: Progress bar disabled or no selector configured');
      }
    }).catch(error => {
      console.error('🎁 GWP Progress Bar Injector: Error loading config:', error);
    });
  }

  // Load configuration from the public API
  async function loadConfig() {
    try {
      const shop = window.Shopify?.shop || getShopFromUrl();
      if (!shop) {
        throw new Error('Could not determine shop URL');
      }

      const response = await fetch(`/apps/gwp/public/gwp-settings?shop=${encodeURIComponent(shop)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const config = await response.json();
      gwpConfig = config;
      progressBarConfig = config.progressBar;
      
      console.log('🎁 GWP Progress Bar Injector: Config loaded:', {
        tiers: gwpConfig.tiers?.length || 0,
        progressBar: progressBarConfig
      });
    } catch (error) {
      console.error('🎁 GWP Progress Bar Injector: Failed to load config:', error);
      throw error;
    }
  }

  // Get shop from URL if not available in window.Shopify
  function getShopFromUrl() {
    const hostname = window.location.hostname;
    if (hostname.includes('.myshopify.com')) {
      return hostname;
    }
    return null;
  }

  // Inject the progress bar at the configured location
  function injectProgressBar() {
    const selector = progressBarConfig.selector;
    const position = progressBarConfig.position;
    
    console.log(`🎁 GWP Progress Bar Injector: Looking for element: ${selector}, position: ${position}`);
    
    // Wait for the target element to be available
    const targetElement = document.querySelector(selector);
    
    if (!targetElement) {
      console.log(`🎁 GWP Progress Bar Injector: Target element not found: ${selector}`);
      // Retry after a short delay in case the element loads later
      setTimeout(injectProgressBar, 1000);
      return;
    }

    console.log(`🎁 GWP Progress Bar Injector: Target element found, creating progress bar`);
    
    // Create the progress bar HTML
    const progressBarHTML = createProgressBarHTML();
    
    // Create a container for the progress bar
    const progressBarContainer = document.createElement('div');
    progressBarContainer.id = 'gwp-progress-bar-container';
    progressBarContainer.innerHTML = progressBarHTML;
    
    // Insert the progress bar based on position
    if (position === 'above') {
      targetElement.parentNode.insertBefore(progressBarContainer, targetElement);
    } else {
      targetElement.parentNode.insertBefore(progressBarContainer, targetElement.nextSibling);
    }
    
    console.log(`🎁 GWP Progress Bar Injector: Progress bar injected ${position} target element`);
    
    // Initialize the progress bar functionality
    initProgressBarFunctionality();
  }

  // Create the progress bar HTML
  function createProgressBarHTML() {
    if (!gwpConfig.tiers || gwpConfig.tiers.length === 0) {
      return '<div class="gwp-progress-bar-error">No gift tiers configured</div>';
    }

    const tiers = gwpConfig.tiers.sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    const maxThreshold = Math.max(...tiers.map(tier => tier.thresholdAmount));
    
    let tiersHTML = '';
    tiers.forEach((tier, index) => {
      const threshold = (tier.thresholdAmount / 100).toFixed(2);
      const isLast = index === tiers.length - 1;
      
      tiersHTML += `
        <div class="gwp-tier" data-tier-id="${tier.id}" data-threshold="${tier.thresholdAmount}">
          <div class="gwp-tier-icon">
            <img src="/apps/gwp/assets/thumbs-up.png" alt="${tier.name}" class="gwp-tier-image">
          </div>
          <div class="gwp-tier-info">
            <div class="gwp-tier-name">${tier.name}</div>
            <div class="gwp-tier-threshold">$${threshold}</div>
          </div>
          ${!isLast ? '<div class="gwp-tier-arrow">→</div>' : ''}
        </div>
      `;
    });

    return `
      <div class="gwp-progress-bar" id="gwp-progress-bar">
        <div class="gwp-progress-header">
          <h3 class="gwp-progress-title">🎁 Free Gift with Purchase</h3>
          <p class="gwp-progress-subtitle">Add more to your cart to unlock free gifts!</p>
        </div>
        
        <div class="gwp-progress-tiers">
          ${tiersHTML}
        </div>
        
        <div class="gwp-progress-status">
          <div class="gwp-progress-text">
            <span id="gwp-current-amount">$0.00</span> of <span id="gwp-next-threshold">$${(tiers[0].thresholdAmount / 100).toFixed(2)}</span>
          </div>
          <div class="gwp-progress-bar-container">
            <div class="gwp-progress-bar-fill" id="gwp-progress-fill"></div>
          </div>
        </div>
        
        <div class="gwp-progress-actions">
          <button class="gwp-claim-button" id="gwp-claim-button" style="display: none;">
            Claim Your Gift!
          </button>
        </div>
      </div>
    `;
  }

  // Initialize progress bar functionality
  function initProgressBarFunctionality() {
    const progressBar = document.getElementById('gwp-progress-bar');
    if (!progressBar) return;

    // Add click handlers to tier icons
    const tierElements = progressBar.querySelectorAll('.gwp-tier');
    tierElements.forEach(tierElement => {
      tierElement.addEventListener('click', () => {
        openGiftModal();
      });
    });

    // Add click handler to claim button
    const claimButton = document.getElementById('gwp-claim-button');
    if (claimButton) {
      claimButton.addEventListener('click', () => {
        openGiftModal();
      });
    }

    // Start monitoring cart updates
    monitorCartUpdates();
  }

  // Monitor cart updates and update progress bar
  function monitorCartUpdates() {
    // Update immediately
    updateProgressBar();
    
    // Listen for cart updates (Shopify's cart API events)
    document.addEventListener('cart:updated', updateProgressBar);
    document.addEventListener('cart:refresh', updateProgressBar);
    
    // Also poll for updates (fallback)
    setInterval(updateProgressBar, 5000);
  }

  // Update the progress bar based on current cart total
  async function updateProgressBar() {
    try {
      const cartTotal = await getCartTotal();
      const tiers = gwpConfig.tiers.sort((a, b) => a.thresholdAmount - b.thresholdAmount);
      
      // Find the next unachieved tier
      let nextTier = null;
      let achievedTiers = [];
      
      for (const tier of tiers) {
        if (cartTotal >= tier.thresholdAmount) {
          achievedTiers.push(tier);
        } else {
          nextTier = tier;
          break;
        }
      }
      
      // Update progress bar display
      updateProgressBarDisplay(cartTotal, nextTier, achievedTiers);
      
    } catch (error) {
      console.error('🎁 GWP Progress Bar Injector: Error updating progress bar:', error);
    }
  }

  // Get current cart total
  async function getCartTotal() {
    try {
      const response = await fetch('/cart.js');
      const cart = await response.json();
      return cart.total_price;
    } catch (error) {
      console.error('🎁 GWP Progress Bar Injector: Error getting cart total:', error);
      return 0;
    }
  }

  // Update progress bar display
  function updateProgressBarDisplay(cartTotal, nextTier, achievedTiers) {
    const currentAmountElement = document.getElementById('gwp-current-amount');
    const nextThresholdElement = document.getElementById('gwp-next-threshold');
    const progressFillElement = document.getElementById('gwp-progress-fill');
    const claimButton = document.getElementById('gwp-claim-button');
    
    if (!currentAmountElement || !nextThresholdElement || !progressFillElement) return;
    
    const cartTotalFormatted = (cartTotal / 100).toFixed(2);
    currentAmountElement.textContent = `$${cartTotalFormatted}`;
    
    // Update tier visual states
    const tierElements = document.querySelectorAll('.gwp-tier');
    tierElements.forEach((tierElement, index) => {
      const tierId = tierElement.dataset.tierId;
      const tier = gwpConfig.tiers.find(t => t.id === tierId);
      
      if (tier && cartTotal >= tier.thresholdAmount) {
        tierElement.classList.add('gwp-tier-achieved');
        tierElement.classList.remove('gwp-tier-locked');
      } else {
        tierElement.classList.add('gwp-tier-locked');
        tierElement.classList.remove('gwp-tier-achieved');
      }
    });
    
    if (nextTier) {
      const nextThresholdFormatted = (nextTier.thresholdAmount / 100).toFixed(2);
      nextThresholdElement.textContent = `$${nextThresholdFormatted}`;
      
      // Calculate progress percentage
      const progress = Math.min((cartTotal / nextTier.thresholdAmount) * 100, 100);
      progressFillElement.style.width = `${progress}%`;
      
      // Show/hide claim button
      if (achievedTiers.length > 0) {
        claimButton.style.display = 'block';
        claimButton.textContent = `Claim Your Gift${achievedTiers.length > 1 ? 's' : ''}!`;
      } else {
        claimButton.style.display = 'none';
      }
    } else {
      // All tiers achieved
      nextThresholdElement.textContent = 'All tiers unlocked!';
      progressFillElement.style.width = '100%';
      claimButton.style.display = 'block';
      claimButton.textContent = `Claim Your Gift${achievedTiers.length > 1 ? 's' : ''}!`;
    }
  }

  // Open the gift modal
  function openGiftModal() {
    // Trigger the cart modal to open
    const event = new CustomEvent('gwp:open-modal');
    document.dispatchEvent(event);
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(); 