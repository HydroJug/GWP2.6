import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || 'hydrojug.myshopify.com';
  
  // Generate the cart modal HTML/JS
  const cartModalScript = `
    (function() {
      // Prevent multiple instances
      if (window.GWP_CART_MODAL_LOADED) {
        console.log('GWP Debug: Cart modal already loaded, skipping...');
        return;
      }
      window.GWP_CART_MODAL_LOADED = true;
      console.log('GWP Debug: Setting GWP_CART_MODAL_LOADED to true');
      
      // Store reference to any existing checkForGift function to avoid conflicts
      const originalCheckForGift = window.checkForGift;
      if (originalCheckForGift) {
        console.log('GWP Debug: Found existing checkForGift function, will avoid conflicts');
      }
      
      // Cart Modal for Gift with Purchase
      let gwpModal = null;
      let gwpConfig = null;
      let isModalOpen = false;
      let cartMonitorInterval = null;
      let lastKnownCartTotal = 0;
      let cartData = null;
      
      // Unique namespace to avoid conflicts
      const GWP_NAMESPACE = 'gwp-modal-' + Date.now();
      const GWP_MODAL_ID = 'gwp-modal-overlay-' + Date.now();
      
      console.log('GWP Debug: Namespace created:', GWP_NAMESPACE);
      
      // Check if modal was recently dismissed (shorter check for immediate re-showing)
      function wasRecentlyDismissed() {
        const modalDismissed = sessionStorage.getItem('gwp_modal_dismissed');
        const dismissedTime = sessionStorage.getItem('gwp_modal_dismissed_time');
        const dismissalType = sessionStorage.getItem('gwp_modal_dismissal_type'); // 'explicit' or 'auto'
        
        if (modalDismissed === 'true') {
          // Only block auto-showing if it was an explicit dismissal (Continue Shopping)
          if (dismissalType === 'explicit') {
            // Check if dismissal was recent (within 5 minutes)
            const fiveMinutes = 5 * 60 * 1000;
            const timeSinceDismissal = Date.now() - parseInt(dismissedTime || '0');
            
            if (timeSinceDismissal < fiveMinutes) {
              console.log('GWP Debug: Modal was explicitly dismissed recently, not auto-showing');
              return true;
            } else {
              console.log('GWP Debug: Modal dismissal expired, clearing flag');
              sessionStorage.removeItem('gwp_modal_dismissed');
              sessionStorage.removeItem('gwp_modal_dismissed_time');
              sessionStorage.removeItem('gwp_modal_dismissal_type');
              return false;
            }
          } else {
            // If it was an auto-close (after adding gifts), don't block auto-showing
            console.log('GWP Debug: Modal was auto-closed after adding gifts, allowing auto-show');
            sessionStorage.removeItem('gwp_modal_dismissed');
            sessionStorage.removeItem('gwp_modal_dismissed_time');
            sessionStorage.removeItem('gwp_modal_dismissal_type');
            return false;
          }
        }
        return false;
      }
      
      // Check if customer qualifies for gifts
      async function checkGiftEligibility(forceShow = false) {
        try {
          console.log('GWP Debug: === CHECKING GIFT ELIGIBILITY ===');
          console.log('GWP Debug: forceShow:', forceShow, 'isModalOpen:', isModalOpen);
          
          // Only check dismissal for auto-showing, not for manual triggers
          if (!forceShow && wasRecentlyDismissed()) {
            console.log('GWP Debug: Modal was recently dismissed, skipping auto-show');
            return;
          }
          
          // For auto-show, use a simpler eligibility check that doesn't filter out tiers with existing gifts
          const eligibleTiers = await checkGiftEligibilityForAutoShow();
          console.log('GWP Debug: Eligible tiers found for auto-show:', eligibleTiers.length);
          eligibleTiers.forEach(tier => {
            console.log('GWP Debug: Eligible tier:', tier.name, 'threshold:', tier.thresholdAmount, 'ID:', tier.id);
          });
          
          // Enhanced debugging for Silver tier specifically
          const cartTotal = await getCartTotal();
          console.log('GWP Debug: Current cart total for eligibility check:', cartTotal, 'cents ($' + (cartTotal / 100).toFixed(2) + ')');
          
          if (gwpConfig) {
            gwpConfig.forEach(tier => {
              const isEligible = cartTotal >= tier.thresholdAmount;
              console.log('GWP Debug: Tier ' + tier.name + ' (' + tier.thresholdAmount + ' cents / $' + (tier.thresholdAmount / 100) + ') - Eligible: ' + isEligible);
              
              if (tier.name === 'Silver' && isEligible) {
                console.log('GWP Debug: *** SILVER TIER IS ELIGIBLE FOR AUTO-SHOW ***');
              }
              if (tier.name === 'Gold' && isEligible) {
                console.log('GWP Debug: *** GOLD TIER IS ELIGIBLE FOR AUTO-SHOW ***');
              }
            });
          }
          
          if (eligibleTiers.length > 0 && !isModalOpen) {
            console.log('GWP Debug: Showing modal for eligible tiers');
            setTimeout(() => {
              console.log('GWP Debug: Executing showGWPModal...');
              showGWPModal();
            }, 500);
          } else {
            if (eligibleTiers.length === 0) {
              console.log('GWP Debug: No eligible tiers found');
            }
            if (isModalOpen) {
              console.log('GWP Debug: Modal already open, not showing again');
            }
          }
        } catch (error) {
          console.error('GWP Debug: ERROR in checkGiftEligibility:', error);
          console.error('GWP Debug: Error stack:', error.stack);
        }
      }
      
      // Simple eligibility check for auto-show - shows modal when customer first becomes eligible
      async function checkGiftEligibilityForAutoShow() {
        try {
          const cartTotal = await getCartTotal();
          console.log('GWP Debug: Checking auto-show eligibility - Cart total:', cartTotal, 'Available tiers:', gwpConfig);
          
          if (!gwpConfig || !Array.isArray(gwpConfig)) {
            console.log('GWP Debug: No valid config available for auto-show');
            return [];
          }
          
          // Simple check: just see if cart total meets any tier threshold
          const eligibleTiers = gwpConfig.filter(tier => {
            const isEligible = cartTotal >= tier.thresholdAmount;
            console.log('GWP Debug: Auto-show tier', tier.name, 'threshold:', tier.thresholdAmount, 'eligible:', isEligible);
            return isEligible;
          });
          
          // Sort tiers by threshold amount (highest first) to prioritize higher tiers
          eligibleTiers.sort((a, b) => b.thresholdAmount - a.thresholdAmount);
          
          console.log('GWP Debug: Auto-show eligible tiers:', eligibleTiers.length);
          return eligibleTiers;
        } catch (error) {
          console.log('GWP Debug: Error checking auto-show eligibility:', error);
          return [];
        }
      }
      
      // Check if customer qualifies for gifts (updated to exclude already added gifts)
      async function checkGiftEligibilityWithCartCheck() {
        try {
          const cartTotal = await getCartTotal();
          console.log('GWP Debug: Checking eligibility - Cart total:', cartTotal, 'Available tiers:', gwpConfig);
          
          if (!gwpConfig || !Array.isArray(gwpConfig)) {
            console.log('GWP Debug: No valid config available');
            return [];
          }
          
          // Get gifts already in cart
          const giftsInCart = await checkGiftsAlreadyInCart();
          
          const eligibleTiers = gwpConfig.filter(tier => {
            const isEligible = cartTotal >= tier.thresholdAmount;
            console.log('GWP Debug: Tier', tier.name, 'threshold:', tier.thresholdAmount, 'eligible:', isEligible);
            return isEligible;
          });
          
          // Sort tiers by threshold amount (highest first) to prioritize higher tiers
          eligibleTiers.sort((a, b) => b.thresholdAmount - a.thresholdAmount);
          
          // Check each tier individually for availability
          const availableTiers = [];
          
          for (const tier of eligibleTiers) {
            // Check if this specific tier already has gifts in cart
            const tierGiftsInCart = cartData?.items?.filter(item => {
              const hasGWPProperty = item.properties && (
                // Cart modal tier identification
                item.properties._gwp_tier_id === tier.id ||
                item.properties['_gwp_tier_id'] === tier.id ||
                item.properties._gwp_tier === tier.name ||
                item.properties['_gwp_tier'] === tier.name ||
                // Checkout extension tier identification
                item.properties._gift_tier_id === tier.id ||
                item.properties['_gift_tier_id'] === tier.id
              );
              return hasGWPProperty;
            }) || [];
            
            console.log('GWP Debug: Tier', tier.name, 'has', tierGiftsInCart.length, 'gifts in cart, max allowed:', tier.maxSelections || 1);
            
            // If this tier hasn't reached its max selections, it's potentially available
            const maxSelections = tier.maxSelections || 1;
            if (tierGiftsInCart.length < maxSelections) {
              // Check if there are any higher tier gifts already in cart that would block this tier
              const hasBlockingHigherTierGifts = eligibleTiers.some(higherTier => {
                // Only check tiers with higher thresholds
                if (higherTier.thresholdAmount <= tier.thresholdAmount) return false;
                
                const higherTierGiftsInCart = cartData?.items?.filter(item => {
                  const hasGWPProperty = item.properties && (
                    item.properties._gwp_tier_id === higherTier.id ||
                    item.properties['_gwp_tier_id'] === higherTier.id ||
                    item.properties._gift_tier_id === higherTier.id ||
                    item.properties['_gift_tier_id'] === higherTier.id
                  );
                  return hasGWPProperty;
                }) || [];
                
                // Only block if the higher tier has reached its max selections
                const higherTierMaxSelections = higherTier.maxSelections || 1;
                const isHigherTierMaxedOut = higherTierGiftsInCart.length >= higherTierMaxSelections;
                
                console.log('GWP Debug: Higher tier', higherTier.name, 'has', higherTierGiftsInCart.length, 'gifts, max:', higherTierMaxSelections, 'maxed out:', isHigherTierMaxedOut);
                
                return isHigherTierMaxedOut;
              });
              
              if (!hasBlockingHigherTierGifts) {
                availableTiers.push(tier);
                console.log('GWP Debug: Tier', tier.name, 'is available for selection');
              } else {
                console.log('GWP Debug: Tier', tier.name, 'is blocked by maxed out higher tier gifts in cart');
              }
            } else {
              console.log('GWP Debug: Tier', tier.name, 'is already maxed out');
            }
          }
          
          console.log('GWP Debug: Available tiers after cart check:', availableTiers.length);
          return availableTiers; // Keep original order (highest first)
        } catch (error) {
          console.log('GWP Debug: Error checking gift eligibility:', error);
          return [];
        }
      }
      
      // Check if gift products are already in cart
      async function checkGiftsAlreadyInCart() {
        try {
          if (!cartData || !cartData.items) {
            console.log('GWP Debug: No cart data available to check for existing gifts');
            return [];
          }
          
          const giftItemsInCart = cartData.items.filter(item => {
            // Check if item has GWP properties indicating it's a gift
            const hasGWPProperty = item.properties && (
              // Cart modal gifts
              item.properties._gwp_gift === 'true' ||
              item.properties['_gwp_gift'] === 'true' ||
              item.properties.gwp_gift === 'true' ||
              item.properties['gwp_gift'] === 'true' ||
              // Checkout extension gifts
              item.properties._gift_with_purchase === 'true' ||
              item.properties['_gift_with_purchase'] === 'true'
            );
            
            // Also check if the price is 0 (common for gifts)
            const isZeroPrice = item.price === 0 || item.final_price === 0;
            
            return hasGWPProperty || isZeroPrice;
          });
          
          console.log('GWP Debug: Found', giftItemsInCart.length, 'gift items already in cart');
          console.log('GWP Debug: Gift items in cart:', giftItemsInCart.map(item => ({ 
            title: item.title, 
            variant_id: item.variant_id,
            properties: item.properties 
          })));
          
          return giftItemsInCart.map(item => item.variant_id.toString());
        } catch (error) {
          console.log('GWP Debug: Error checking gifts in cart:', error);
          return [];
        }
      }
      
      // Check eligibility for progress bar clicks - shows ALL eligible tiers regardless of cart contents
      async function checkGiftEligibilityForProgressBar() {
        try {
          const cartTotal = await getCartTotal();
          console.log('GWP Debug: Checking progress bar eligibility - Cart total:', cartTotal);
          
          if (!gwpConfig || !Array.isArray(gwpConfig)) {
            console.log('GWP Debug: No valid config available for progress bar');
            return [];
          }
          
          const eligibleTiers = gwpConfig.filter(tier => {
            const isEligible = cartTotal >= tier.thresholdAmount;
            console.log('GWP Debug: Progress bar tier', tier.name, 'threshold:', tier.thresholdAmount, 'eligible:', isEligible);
            return isEligible;
          });
          
          // Sort tiers by threshold amount (highest first)
          eligibleTiers.sort((a, b) => b.thresholdAmount - a.thresholdAmount);
          
          console.log('GWP Debug: Progress bar eligible tiers:', eligibleTiers.length);
          return eligibleTiers;
        } catch (error) {
          console.log('GWP Debug: Error checking progress bar eligibility:', error);
          return [];
        }
      }
      
      // Styles for the modal
      const modalStyles = \`
        .gwp-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
          z-index: 12000;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          visibility: hidden;
          transition: all 0.3s ease;
        }
        
        .gwp-modal-overlay.active {
          opacity: 1;
          visibility: visible;
        }
        
        .gwp-modal {
          background: white;
          border-radius: 12px;
          max-width: 500px;
          width: 90%;
          max-height: 80vh;
          overflow-y: auto;
          position: relative;
          transform: scale(0.9);
          transition: transform 0.3s ease;
        }
        
        .gwp-modal-overlay.active .gwp-modal {
          transform: scale(1);
        }
        
        .gwp-modal-header {
          padding: 24px 24px 16px;
          text-align: center;
          border-bottom: 1px solid #e5e5e5;
          position: relative;
        }
        
        .gwp-modal-close {
          position: absolute;
          top: 16px;
          right: 16px;
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: #666;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background-color 0.2s;
        }
        
        .gwp-modal-close:hover {
          background-color: #f5f5f5;
        }
        
        .gwp-modal-title {
          font-size: 24px;
          font-weight: bold;
          margin: 0 0 8px;
          color: #333;
        }
        
        .gwp-modal-subtitle {
          font-size: 16px;
          color: #666;
          margin: 0;
        }
        
        .gwp-modal-body {
          padding: 24px;
        }
        
        .gwp-tier-section {
          margin-bottom: 32px;
        }
        
        .gwp-tier-title {
          font-size: 18px;
          font-weight: 600;
          margin-bottom: 16px;
          color: #333;
        }
        
        .gwp-products-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 16px;
        }
        
        /* Mobile responsive - 3 columns on mobile */
        .gwp-modal-body {
          padding: 14px;
        }

        @media (max-width: 740px) {
          .gwp-products-grid {
            grid-template-columns: repeat(3, 1fr);
            gap: 5px;
          }
          
          .gwp-product-image {
            width: 60px;
            height: 60px;
          }
          
          .gwp-product-title {
            font-size: 12px;
          }
          
          .gwp-product-price,
          .gwp-product-free {
            font-size: 10px;
          }
        }
        
        .gwp-product-card {
          border: 2px solid #e5e5e5;
          border-radius: 8px;
          padding: 8px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
          background: white;
        }
        
        .gwp-product-card:hover {
          border-color: #0161FE;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 124, 186, 0.15);
        }
        
        .gwp-product-card.selected {
          border-color: #0161FE;
          background-color: #f0f8ff;
        }
        
        .gwp-product-image {
          width: 75px;
          height: 75px;
          object-fit: cover;
          border-radius: 6px;
          margin: -5px auto 8px auto;
          display: block;
        }
        
        .gwp-product-title {
          font-size: 12px;
          font-weight: 500;
          color: #333;
          margin: 0;
          line-height: 1.3;
        }
        
        .gwp-product-price {
          font-size: 12px;
          color: #666;
          margin: 2px 0 0;
          text-decoration: line-through;
        }
        
        .gwp-product-free {
          font-size: 12px;
          color: #28a745;
          font-weight: 600;
          margin: 2px 0 0;
        }
        
        .gwp-modal-footer {
          padding: 16px 24px 24px;
          border-top: 1px solid #e5e5e5;
          display: flex;
          gap: 12px;
        }
        
        .gwp-button {
          flex: 1;
          padding: 8px 14px;
          border: none;
          line-height: 1.2em;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .gwp-button-primary {
          background-color: #0161FE;
          color: white;
        }
        
        .gwp-button-primary:hover {
          background-color: #005a87;
        }
        
        .gwp-button-primary:disabled {
          background-color: #ccc;
          cursor: not-allowed;
        }
        
        .gwp-button-secondary {
          background-color: #f5f5f5;
          color: #333;
          border: 1px solid #ddd;
        }
        
        .gwp-button-secondary:hover {
          background-color: #e5e5e5;
        }
        
        .gwp-loading {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        
        .gwp-error {
          text-align: center;
          padding: 40px;
          color: #dc3545;
        }
        
        .gwp-fine-print {
          text-align: center;
          font-size: 11px;
          color: #666;
          padding: 8px 16px;
          border-top: 1px solid #e5e5e5;
          background-color: #f9f9f9;
        }
      \`;
      
      // Add styles to page
      function addStyles() {
        const existingStyles = document.getElementById('gwp-modal-styles');
        if (!existingStyles) {
          const styleSheet = document.createElement('style');
          styleSheet.id = 'gwp-modal-styles';
          styleSheet.textContent = modalStyles;
          document.head.appendChild(styleSheet);
        }
      }
      
      // Safe element selector with error handling
      function safeQuerySelector(selector) {
        try {
          return document.querySelector(selector);
        } catch (error) {
          console.log('GWP Debug: Error selecting element:', selector, error);
          return null;
        }
      }
      
      // Fetch cart data via AJAX - primary method
      async function fetchCartData() {
        try {
          console.log('GWP Debug: Fetching cart data via AJAX...');
          const response = await fetch('/cart.js');
          const cart = await response.json();
          console.log('GWP Debug: Cart data fetched:', cart);
          cartData = cart;
          
          // Update Shopify.cart if it exists
          if (window.Shopify && !window.Shopify.cart) {
            window.Shopify.cart = cart;
          }
          
          // Update progress bar icons after cart data is updated
          setTimeout(() => {
            console.log('GWP Debug: Updating progress bar icons after cart data fetch');
            updateProgressBarIcons();
          }, 300);
          
          // Additional icon update attempts
          setTimeout(() => {
            console.log('GWP Debug: Second progress bar icon update after cart data fetch');
            updateProgressBarIcons();
          }, 1000);
          
          // Immediately check for gift eligibility after cart data is updated
          setTimeout(() => {
            console.log('GWP Debug: Cart data updated, checking eligibility...');
            checkGiftEligibility();
          }, 100);
          
          return cart.total_price || 0;
        } catch (error) {
          console.log('GWP Debug: Error fetching cart via AJAX:', error);
          return 0;
        }
      }
      
      // Get cart total with improved error handling and multiple methods
      async function getCartTotal() {
        let total = 0;
        let method = 'unknown';
        
        try {
          // Method 1: Use cached cart data if available
          if (cartData && typeof cartData.total_price === 'number') {
            total = cartData.total_price;
            method = 'cached cartData';
          }
          // Method 2: Try Shopify.cart object
          else if (window.Shopify && window.Shopify.cart && typeof window.Shopify.cart.total_price === 'number') {
          total = window.Shopify.cart.total_price;
          method = 'Shopify.cart.total_price';
        }
          // Method 3: Try window.cart object
        else if (window.cart && typeof window.cart.total_price === 'number') {
          total = window.cart.total_price;
          method = 'window.cart.total_price';
        }
          // Method 4: Fetch via AJAX
        else {
            total = await fetchCartData();
            method = 'AJAX fetch';
        }
        
        // Only log if this is a debug call or if total has changed
        if (arguments[0] === 'debug' || total !== lastKnownCartTotal) {
        console.log('GWP Debug: Cart total detected: $' + (total / 100).toFixed(2) + ' via ' + method);
        }
        return total;
        } catch (error) {
          console.log('GWP Debug: Error getting cart total:', error);
          return 0;
        }
      }
      
      // Fetch GWP configuration
      async function fetchGWPConfig() {
        try {
          console.log('GWP Debug: Fetching GWP configuration...');
          const response = await fetch(\`https://gwp-2-5.vercel.app/api/public/gwp-settings?shop=${shop}\`);
          const data = await response.json();
          console.log('GWP Debug: GWP config response:', data);
          
          const tiers = JSON.parse(data.tiers);
          console.log('GWP Debug: Parsed tiers:', tiers);
          
          // Log each tier's details
          tiers.forEach((tier, index) => {
            console.log(\`GWP Debug: Tier \${index}:\`, {
              id: tier.id,
              name: tier.name,
              thresholdAmount: tier.thresholdAmount,
              collectionHandle: tier.collectionHandle,
              collectionId: tier.collectionId,
              collectionTitle: tier.collectionTitle,
              hasGiftProducts: tier.giftProducts?.length || 0
            });
          });
          
          return tiers;
        } catch (error) {
          console.error('GWP Debug: Error fetching GWP config:', error);
          return [];
        }
      }
      
      // Fetch products from collection
      async function fetchCollectionProducts(collectionHandle) {
        try {
          console.log('GWP Debug: Fetching products from collection:', collectionHandle);
          const response = await fetch(\`/collections/\${collectionHandle}/products.json?limit=10\`);
          
          if (!response.ok) {
            console.log('GWP Debug: Collection response not OK:', response.status, response.statusText);
            return [];
          }
          
          const data = await response.json();
          console.log('GWP Debug: Collection data received:', data);
          
          if (!data.products || !Array.isArray(data.products)) {
            console.log('GWP Debug: No products array in collection data');
          return [];
        }
          
          console.log('GWP Debug: Total products in collection:', data.products.length);
          
          // Expand all available variants as separate selectable options
          const allVariants = [];
          
          data.products.forEach(product => {
            if (!product.variants || !Array.isArray(product.variants)) {
              console.log('GWP Debug: Product has no variants:', product.title);
              return;
            }
            
            // Filter available variants
            const availableVariants = product.variants.filter(variant => {
              const isAvailable = variant && variant.available;
              console.log('GWP Debug: Variant', variant.title, 'of', product.title, 'available:', isAvailable);
              return isAvailable;
            });
            
            // Convert each variant to a selectable option
            availableVariants.forEach(variant => {
              // Use variant-specific image if available, otherwise fall back to product image
              let variantImage = null;
              
              // Try to find variant-specific image
              if (variant.featured_image) {
                variantImage = variant.featured_image.src || variant.featured_image;
              } else if (variant.image_id && product.images) {
                const matchingImage = product.images.find(img => img.id === variant.image_id);
                if (matchingImage) {
                  variantImage = matchingImage.src;
                }
              }
              
              // Fall back to product's featured image or first image
              if (!variantImage) {
                variantImage = product.images?.[0]?.src || product.featured_image || 'https://via.placeholder.com/150x150/cccccc/666666?text=No+Image';
              }
              
              // Create a display title that includes both product and variant info
              let displayTitle = product.title;
              if (variant.title && variant.title !== 'Default Title' && variant.title !== product.title) {
                // If variant has a meaningful title, append it
                displayTitle = \`\${product.title} - \${variant.title}\`;
              }
              
              allVariants.push({
                variantId: variant.id.toString(),
                productId: product.id.toString(),
                title: displayTitle,
                productTitle: product.title,
                variantTitle: variant.title,
                image: variantImage,
                price: (variant.price * 100).toString() // Convert to cents
              });
              
              console.log('GWP Debug: Added variant option:', {
                title: displayTitle,
                variantId: variant.id,
                image: variantImage ? variantImage.substring(0, 50) + '...' : 'No image'
              });
            });
          });
          
          // Limit to reasonable number of options (12 variants max)
          const limitedVariants = allVariants.slice(0, 12);
          
          console.log('GWP Debug: Found', allVariants.length, 'total available variants, showing', limitedVariants.length, 'in collection', collectionHandle);
          return limitedVariants;
        } catch (error) {
          console.error('GWP Debug: Error fetching collection products:', error);
          return [];
        }
      }
      
      // Selected gifts tracking
      let selectedGifts = [];
      
      // Create global functions with simpler names to avoid truncation
      const closeModalFunctionName = \`closeGWPModal_\${Date.now()}\`;
      const selectProductFunctionName = \`selectGiftProduct_\${Date.now()}\`;
      const addToCartFunctionName = \`addSelectedGiftsToCart_\${Date.now()}\`;
      const dismissModalFunctionName = \`dismissGWPModal_\${Date.now()}\`;
      const removeGiftFunctionName = \`removeGiftFromCart_\${Date.now()}\`;
      const refreshModalFunctionName = \`refreshModalContent_\${Date.now()}\`;
      
      // Select gift product with unique function name
      window[selectProductFunctionName] = function(variantId, tierId, element) {
        try {
          console.log('GWP Debug: Gift selection triggered - Variant ID:', variantId, 'Tier ID:', tierId);
          
        const tier = gwpConfig.find(t => t.id === tierId);
        if (!tier) {
          console.log('GWP Debug: ERROR - Tier not found for ID:', tierId);
          console.log('GWP Debug: Available tiers:', gwpConfig.map(t => ({ id: t.id, name: t.name })));
          return;
        }
        
        console.log('GWP Debug: Found tier:', tier.name, 'for selection');
        
        // Remove previous selection for this tier
        selectedGifts = selectedGifts.filter(gift => gift.tierId !== tierId);
        console.log('GWP Debug: Removed previous selections for tier, remaining selections:', selectedGifts.length);
        
        // Remove selected class from other products in this tier
        const tierSection = element.closest('.gwp-tier-section');
          if (tierSection) {
        tierSection.querySelectorAll('.gwp-product-card').forEach(card => {
          card.classList.remove('selected');
        });
          }
        
        // Add selection
        element.classList.add('selected');
        selectedGifts.push({
          variantId: variantId,
          tierId: tierId,
          tierName: tier.name
        });
        
        console.log('GWP Debug: Added gift selection:', {
          variantId: variantId,
          tierId: tierId,
          tierName: tier.name
        });
        console.log('GWP Debug: Total selected gifts:', selectedGifts.length);
        
        // Update button
        updateAddToCartButton();
        } catch (error) {
          console.log('GWP Debug: Error selecting gift product:', error);
        }
      };
      
      // Update add to cart button
      function updateAddToCartButton() {
        try {
          const button = document.getElementById(\`gwp-add-to-cart-btn-\${GWP_NAMESPACE}\`);
          if (button) {
        if (selectedGifts.length > 0) {
          button.disabled = false;
          button.textContent = \`Add to cart (\${selectedGifts.length})\`;
        } else {
          button.disabled = true;
          button.textContent = 'Add to cart (0)';
            }
          }
        } catch (error) {
          console.log('GWP Debug: Error updating add to cart button:', error);
        }
      }
      
      // Add selected gifts to cart with unique function name
      window[addToCartFunctionName] = async function() {
        if (selectedGifts.length === 0) return;
        
        const button = document.getElementById(\`gwp-add-to-cart-btn-\${GWP_NAMESPACE}\`);
        if (button) {
        button.disabled = true;
        button.textContent = 'Adding...';
        }
        
        try {
          // Refresh cart data to get current state
          await fetchCartData();
          
          // Before adding new gifts, remove any existing gifts from the SAME tiers we're about to add to
          if (cartData && cartData.items) {
            const giftsToRemove = [];
            
            // Find existing gifts for the specific tiers we're about to add to
            selectedGifts.forEach(selectedGift => {
              const existingGiftsInTier = cartData.items.filter(item => {
                const hasGWPProperty = item.properties && (
                  item.properties._gwp_tier_id === selectedGift.tierId ||
                  item.properties['_gwp_tier_id'] === selectedGift.tierId ||
                  item.properties._gift_tier_id === selectedGift.tierId ||
                  item.properties['_gift_tier_id'] === selectedGift.tierId
                );
                return hasGWPProperty;
              });
              
              // Add these to removal list
              existingGiftsInTier.forEach(gift => {
                if (!giftsToRemove.find(g => g.key === gift.key)) {
                  giftsToRemove.push(gift);
                }
              });
            });
            
            // Remove existing gifts from the same tiers only
            for (const giftToRemove of giftsToRemove) {
              try {
                console.log('GWP Debug: Removing existing gift from same tier before adding new one:', giftToRemove.title);
                await fetch('/cart/change.js', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    id: giftToRemove.key,
                    quantity: 0
                  })
                });
              } catch (removeError) {
                console.log('GWP Debug: Error removing existing gift:', removeError);
              }
            }
            
            // Wait a moment for removals to complete
            if (giftsToRemove.length > 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
              await fetchCartData(); // Refresh cart data after removals
            }
          }
          
          // Add each selected gift to cart with GWP properties
          for (const gift of selectedGifts) {
            // Double-check that this gift isn't already in the cart
            const alreadyInCart = cartData?.items?.find(item => 
              item.variant_id.toString() === gift.variantId.toString() &&
              item.properties && (
                item.properties._gwp_tier_id === gift.tierId ||
                item.properties['_gwp_tier_id'] === gift.tierId ||
                item.properties._gift_tier_id === gift.tierId ||
                item.properties['_gift_tier_id'] === gift.tierId
              )
            );
            
            if (alreadyInCart) {
              console.log('GWP Debug: Gift already in cart, skipping:', gift);
              continue;
            }
            
            const formData = new FormData();
            formData.append('id', gift.variantId);
            formData.append('quantity', '1');
            
            // Add GWP properties to identify this as a gift
            formData.append('properties[_gwp_gift]', 'true');
            formData.append('properties[_gwp_tier]', gift.tierName);
            formData.append('properties[_gwp_tier_id]', gift.tierId);
            formData.append('properties[_gwp_added_via]', 'cart_modal');
            
            console.log('GWP Debug: Adding gift to cart:', {
              variantId: gift.variantId,
              tierName: gift.tierName,
              tierId: gift.tierId
            });
            
            // Try using Shopify's AJAX API first (better theme integration)
            try {
              const ajaxResponse = await fetch('/cart/add.js', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  id: gift.variantId,
                  quantity: 1,
                  properties: {
                    '_gwp_gift': 'true',
                    '_gwp_tier': gift.tierName,
                    '_gwp_tier_id': gift.tierId,
                    '_gwp_added_via': 'cart_modal'
                  }
                })
              });
              
              if (ajaxResponse.ok) {
                console.log('GWP Debug: Successfully added gift via AJAX API');
              } else {
                console.log('GWP Debug: AJAX API failed, trying FormData approach');
                // Fallback to FormData approach
                const formResponse = await fetch('/cart/add.js', {
              method: 'POST',
              body: formData
            });
                
                if (!formResponse.ok) {
                  console.error('GWP Debug: Error adding gift to cart:', formResponse.status, formResponse.statusText);
                } else {
                  console.log('GWP Debug: Successfully added gift via FormData');
                }
              }
            } catch (ajaxError) {
              console.log('GWP Debug: AJAX approach failed, using FormData:', ajaxError);
              // Fallback to original FormData approach
              const response = await fetch('/cart/add.js', {
                method: 'POST',
                body: formData
              });
              
              if (!response.ok) {
                console.error('GWP Debug: Error adding gift to cart:', response.status, response.statusText);
          } else {
                console.log('GWP Debug: Successfully added gift to cart');
              }
            }
          }
          
          // Refresh cart data
          await fetchCartData();
          
          // Additional refresh to ensure cart is up to date
          setTimeout(async () => {
            await fetchCartData();
            console.log('GWP Debug: Additional cart refresh after adding gifts');
          }, 1000);
          
          // Update progress bar icons with newly added gifts - multiple attempts
          setTimeout(() => {
            console.log('GWP Debug: First progress bar icon update attempt');
            updateProgressBarIcons();
          }, 1500);
          
          setTimeout(() => {
            console.log('GWP Debug: Second progress bar icon update attempt');
            updateProgressBarIcons();
          }, 3000);
          
          setTimeout(() => {
            console.log('GWP Debug: Third progress bar icon update attempt');
            updateProgressBarIcons();
          }, 5000);
          
          // Try to trigger cart drawer update instead of redirecting
          try {
            // Force refresh the cart data first
            const cartResponse = await fetch('/cart.js');
            const updatedCart = await cartResponse.json();
            cartData = updatedCart;
            
            // Update Shopify.cart if it exists
            if (window.Shopify) {
              window.Shopify.cart = updatedCart;
            }
            
            // Force refresh cart drawer content by reloading the cart section
            try {
              // Instead of manually updating cart drawer HTML (which can cause iframe issues),
              // let's rely on the theme's own refresh mechanisms
              console.log('GWP Debug: Triggering theme-based cart refresh to avoid iframe issues');
              
              // Method 1: Trigger theme's cart refresh functions
              const themeRefreshMethods = [
                () => window.theme?.cart?.refresh?.(),
                () => window.Shopify?.theme?.cart?.refresh?.(),
                () => window.cartRefresh?.(),
                () => window.updateCart?.(),
                () => window.refreshCart?.()
              ];
              
              for (const method of themeRefreshMethods) {
                try {
                  const result = method();
                  if (result) {
                    console.log('GWP Debug: Successfully called theme refresh method');
                    break;
                  }
                } catch (methodError) {
                  // Continue to next method
                }
              }
              
              // Method 2: Dispatch cart events that themes typically listen to
              const cartEvents = [
                { name: 'cart:updated', detail: { cart: updatedCart } },
                { name: 'cart:refresh', detail: { cart: updatedCart } },
                { name: 'drawer:updated', detail: { cart: updatedCart } }
              ];
              
              cartEvents.forEach(({ name, detail }) => {
                try {
                  const event = new CustomEvent(name, { detail, bubbles: true });
                  document.dispatchEvent(event);
                  console.log('GWP Debug: Dispatched', name, 'event');
                } catch (eventError) {
                  console.log('GWP Debug: Error dispatching', name, ':', eventError);
                }
              });
              
              // Method 3: Try to find cart drawer and trigger its refresh without HTML manipulation
              const cartDrawerSelectors = [
                '[data-cart-drawer]',
                '.cart-drawer',
                '.js-cart-drawer',
                '#cart-drawer',
                '.drawer--cart'
              ];
              
              for (const selector of cartDrawerSelectors) {
                try {
                  const cartDrawer = document.querySelector(selector);
                  if (cartDrawer) {
                    console.log('GWP Debug: Found cart drawer, triggering safe refresh:', selector);
                    
                    // Try to find refresh buttons or triggers within the drawer
                    const refreshTriggers = cartDrawer.querySelectorAll('[data-cart-refresh], .cart-refresh, .js-cart-refresh');
                    refreshTriggers.forEach(trigger => {
                      if (typeof trigger.click === 'function') {
                        trigger.click();
                        console.log('GWP Debug: Clicked cart refresh trigger');
                      }
                    });
                    
                    // Dispatch events directly on the drawer
                    const drawerEvents = ['cart:refresh', 'drawer:refresh', 'cart:updated'];
                    drawerEvents.forEach(eventName => {
                      try {
                        const event = new CustomEvent(eventName, { 
                          detail: { cart: updatedCart },
                          bubbles: false 
                        });
                        cartDrawer.dispatchEvent(event);
                      } catch (drawerEventError) {
                        console.log('GWP Debug: Error dispatching drawer event:', drawerEventError);
                      }
                    });
                    
                    break;
                  }
                } catch (drawerError) {
                  console.log('GWP Debug: Error with cart drawer:', drawerError);
                }
              }
              
              console.log('GWP Debug: Completed safe cart refresh - no HTML manipulation');
              
            } catch (drawerRefreshError) {
              console.log('GWP Debug: Error in safe cart refresh:', drawerRefreshError);
            }
            
            // Dispatch only one essential cart event with a delay to allow content to update
            setTimeout(() => {
              try {
                const customEvent = new CustomEvent('cart:updated', { 
                  detail: { 
                    cart: updatedCart,
                    addedItems: selectedGifts,
                    source: 'gwp_modal'
                  },
                  bubbles: false
                });
                
                document.dispatchEvent(customEvent);
                console.log('GWP Debug: Dispatched cart:updated event');
              } catch (eventError) {
                console.log('GWP Debug: Error dispatching cart event:', eventError);
              }
            }, 500);
            
            // Try to open cart drawer if it exists and isn't already open
            setTimeout(() => {
              try {
                console.log('GWP Debug: === ATTEMPTING TO OPEN CART DRAWER ===');
                console.log('GWP Debug: Attempting to open cart drawer after adding gifts...');
                
                // Method 1: Use the cart-drawer custom element's show() method (from the working liquid code)
                const cartDrawerElement = document.querySelector("cart-drawer");
                if (cartDrawerElement && typeof cartDrawerElement.show === 'function') {
                  console.log('GWP Debug: Found cart-drawer element, calling show() method');
                  cartDrawerElement.show();
                  console.log('GWP Debug: Successfully called cart-drawer.show()');
                  return; // Exit early if successful
                } else {
                  console.log('GWP Debug: cart-drawer element not found or no show() method');
                }
                
                // Method 2: Try the cart-drawer ID selector
                const cartDrawerById = document.getElementById("cart-drawer");
                if (cartDrawerById && typeof cartDrawerById.show === 'function') {
                  console.log('GWP Debug: Found cart-drawer by ID, calling show() method');
                  cartDrawerById.show();
                  console.log('GWP Debug: Successfully called cart-drawer.show() via ID');
                  return; // Exit early if successful
                } else {
                  console.log('GWP Debug: cart-drawer by ID not found or no show() method');
                }
                
                // Method 3: Dispatch cart:refresh event (from working liquid code)
                console.log('GWP Debug: Trying cart:refresh event dispatch');
                document.dispatchEvent(new CustomEvent('cart:refresh', { 
                  detail: cartData,
                  bubbles: true 
                }));
                console.log('GWP Debug: Dispatched cart:refresh event');
                
                // Method 4: Try to manually open drawer by adding classes (fallback)
                const cartDrawerSelectors = [
                  'cart-drawer',
                  '#cart-drawer',
                  '[data-cart-drawer]',
                  '.cart-drawer'
                ];
                
                let drawerOpened = false;
                for (const selector of cartDrawerSelectors) {
                  try {
                    const drawer = document.querySelector(selector);
                    if (drawer) {
                      console.log('GWP Debug: Found cart drawer element:', selector);
                      
                      // Try calling show method if it exists
                      if (typeof drawer.show === 'function') {
                        drawer.show();
                        console.log('GWP Debug: Called show() method on:', selector);
                        drawerOpened = true;
                        break;
                      }
                      
                      // Try adding open classes
                      const openClasses = ['is-open', 'open', 'active', 'show', 'visible'];
                      openClasses.forEach(className => {
                        drawer.classList.add(className);
                      });
                      
                      // Remove closed classes
                      const closedClasses = ['is-closed', 'closed', 'inactive', 'hide', 'hidden'];
                      closedClasses.forEach(className => {
                        drawer.classList.remove(className);
                      });
                      
                      console.log('GWP Debug: Added open classes to cart drawer');
                      drawerOpened = true;
                      break;
                    }
                  } catch (drawerError) {
                    console.log('GWP Debug: Error with cart drawer selector:', selector, drawerError);
                  }
                }
                
                if (!drawerOpened) {
                  console.log('GWP Debug: Could not open cart drawer - no suitable method found');
                } else {
                  console.log('GWP Debug: Cart drawer opening attempted successfully');
                }
                
        } catch (error) {
                console.log('GWP Debug: Error in cart drawer opening logic:', error);
              }
            }, 800); // Reduced delay for faster response
            
            // Force update cart count and total in header
            setTimeout(() => {
              try {
                // Update cart count
                const cartCountSelectors = [
                  '[data-cart-count]',
                  '.cart-count',
                  '.cart__count',
                  '.header__cart-count',
                  '.cart-link__bubble',
                  '.cart-count-bubble'
                ];
                
                cartCountSelectors.forEach(selector => {
                  try {
                    const countElement = document.querySelector(selector);
                    if (countElement && updatedCart.item_count !== undefined) {
                      countElement.textContent = updatedCart.item_count.toString();
                      console.log('GWP Debug: Updated cart count to:', updatedCart.item_count);
                    }
                  } catch (countError) {
                    console.log('GWP Debug: Error updating cart count for', selector, ':', countError);
                  }
                });
                
                // Update cart total
                const cartTotalSelectors = [
                  '[data-cart-total]',
                  '.cart-total',
                  '.cart__total-price',
                  '.cart-drawer__total',
                  '.cart-subtotal'
                ];
                
                cartTotalSelectors.forEach(selector => {
                  try {
                    const totalElement = document.querySelector(selector);
                    if (totalElement && updatedCart.total_price !== undefined) {
                      const formattedTotal = (updatedCart.total_price / 100).toFixed(2);
                      totalElement.textContent = '$' + formattedTotal;
                      console.log('GWP Debug: Updated cart total to:', formattedTotal);
                    }
                  } catch (totalError) {
                    console.log('GWP Debug: Error updating cart total for', selector, ':', totalError);
                  }
                });
              } catch (updateError) {
                console.log('GWP Debug: Error updating cart display:', updateError);
              }
            }, 1500);
            
            // Restore theme function after all operations are complete
            setTimeout(() => {
              if (originalCheckForGift) {
                window.checkForGift = originalCheckForGift;
                console.log('GWP Debug: Restored theme checkForGift function');
              } else {
                // If there was no original function, remove our placeholder
                delete window.checkForGift;
                console.log('GWP Debug: Removed placeholder checkForGift function');
              }
            }, 3000); // Wait longer to ensure all operations are complete
            
          } catch (drawerError) {
            console.log('GWP Debug: Error trying to refresh cart drawer:', drawerError);
            
            // Always restore theme function even if there's an error
            setTimeout(() => {
              if (originalCheckForGift) {
                window.checkForGift = originalCheckForGift;
                console.log('GWP Debug: Restored theme checkForGift after error');
              }
            }, 1000);
          }
          
          window[closeModalFunctionName](true); // Auto-close after adding gifts
          
          // Show success message
          if (window.Shopify && window.Shopify.theme && window.Shopify.theme.showQuickShopSuccess) {
            window.Shopify.theme.showQuickShopSuccess(\`Added \${selectedGifts.length} free gift\${selectedGifts.length > 1 ? 's' : ''} to cart!\`);
          }
          
          console.log('GWP Debug: === FINISHED ADDING ALL GIFTS ===');
          console.log('GWP Debug: Total gifts processed:', selectedGifts.length);
          console.log('GWP Debug: Starting post-gift-addition processing...');
          
          // Refresh cart data
          await fetchCartData();
          
        } catch (error) {
          console.error('GWP Debug: Error adding gifts to cart:', error);
          if (button) {
          button.disabled = false;
          button.textContent = \`Add to cart (\${selectedGifts.length})\`;
          }
        }
      };
      
      // Close modal with improved error handling and unique function name
      window[closeModalFunctionName] = function(isAutoClose = false) {
        try {
          if (isAutoClose) {
            console.log('GWP Debug: Modal auto-closing after adding gifts, not setting dismissal flag');
          } else {
            console.log('GWP Debug: User closed modal via X button, setting dismissal flag');
            // Set session storage flag to remember user dismissed the modal (explicit dismissal)
            sessionStorage.setItem('gwp_modal_dismissed', 'true');
            sessionStorage.setItem('gwp_modal_dismissed_time', Date.now().toString());
            sessionStorage.setItem('gwp_modal_dismissal_type', 'explicit');
          }
          
          // Reset user interaction flag
          userInteracting = false;
          
          // Clear selected gifts to prevent duplicates on next open
          selectedGifts = [];
          
          const overlay = document.getElementById(GWP_MODAL_ID);
        if (overlay) {
          overlay.classList.remove('active');
          setTimeout(() => {
              try {
                if (overlay.parentNode) {
                  overlay.parentNode.removeChild(overlay);
                }
            isModalOpen = false;
              } catch (removeError) {
                console.log('GWP Debug: Error removing modal from DOM:', removeError);
                isModalOpen = false;
              }
          }, 300);
          } else {
            isModalOpen = false;
          }
        } catch (error) {
          console.log('GWP Debug: Error closing modal:', error);
          isModalOpen = false;
          userInteracting = false;
        }
      };
      
      // Close modal and remember user dismissed it
      window[dismissModalFunctionName] = function() {
        try {
          console.log('GWP Debug: User dismissed modal via Continue Shopping, setting explicit dismissal flag');
          
          // Reset user interaction flag
          userInteracting = false;
          
          // Set session storage flag to remember user explicitly dismissed the modal
          sessionStorage.setItem('gwp_modal_dismissed', 'true');
          sessionStorage.setItem('gwp_modal_dismissed_time', Date.now().toString());
          sessionStorage.setItem('gwp_modal_dismissal_type', 'explicit');
          
          // Clear selected gifts to prevent duplicates on next open
          selectedGifts = [];
          
          // Close the modal (pass false since this is explicit dismissal, not auto-close)
          window[closeModalFunctionName](false);
        } catch (error) {
          console.log('GWP Debug: Error dismissing modal:', error);
          userInteracting = false;
          window[closeModalFunctionName](false);
        }
      };
      
      // Make progress bar clickable to reopen modal
      function makeProgressBarClickable() {
        try {
          const progressBarContainer = document.querySelector('.custom-progress-bar-container');
          const progressMessage = document.querySelector('#progress-bar-message');
          
          if (progressBarContainer) {
            // Make the entire progress bar clickable if any tier is eligible
            const cartTotal = lastKnownCartTotal || 0;
            const hasEligibleTiers = gwpConfig && gwpConfig.some(tier => cartTotal >= tier.thresholdAmount);
            
            if (hasEligibleTiers) {
              progressBarContainer.style.cursor = 'pointer';
              progressBarContainer.title = 'Click to manage your free gifts';
              
              // Remove any existing click handlers to avoid duplicates
              progressBarContainer.removeEventListener('click', progressBarClickHandler);
              
              // Add click handler
              progressBarContainer.addEventListener('click', progressBarClickHandler);
              
              console.log('GWP Debug: Made progress bar clickable for eligible tiers');
            }
            
            // Also check the message for additional clickability
            if (progressMessage) {
              if (progressMessage.textContent.includes('Free Gift') && progressMessage.textContent.includes('Earned')) {
                progressBarContainer.style.cursor = 'pointer';
                progressBarContainer.title = 'Click to choose your free gift';
                
                // Remove any existing click handlers to avoid duplicates
                progressBarContainer.removeEventListener('click', progressBarClickHandler);
                
                // Add click handler
                progressBarContainer.addEventListener('click', progressBarClickHandler);
                
                console.log('GWP Debug: Made progress bar clickable via message text');
              }
            }
          }
          
          // Also make individual progress icons clickable for their specific tiers
          makeProgressIconsClickable();
        } catch (error) {
          console.log('GWP Debug: Error making progress bar clickable:', error);
        }
      }
      
      // Make individual progress icons clickable for their specific tiers
      function makeProgressIconsClickable() {
        try {
          const progressBarContainer = document.querySelector('.custom-progress-bar-container');
          if (!progressBarContainer) {
            console.log('GWP Debug: No progress bar container found for icon clicks');
            return;
          }
          
          // Look for progress icons
          const iconSelectors = [
            '.custom-progress-icon.complete',
            '.progress-icon.complete',
            '.progress-step.complete',
            '.tier-icon.complete',
            '.gwp-icon.complete',
            '[data-tier-complete="true"]',
            '.progress-bar-icon.complete',
            '.step-complete'
          ];
          
          let progressIcons = [];
          for (const selector of iconSelectors) {
            const icons = progressBarContainer.querySelectorAll(selector);
            if (icons.length > 0) {
              progressIcons = Array.from(icons);
              console.log('GWP Debug: Found progress icons for click handling:', selector, 'count:', icons.length);
              break;
            }
          }
          
          if (progressIcons.length === 0) {
            console.log('GWP Debug: No progress icons found for click handling');
            return;
          }
          
          // Make each gift tier icon clickable
          progressIcons.forEach((icon, index) => {
            try {
              let iconThresholdAmount = null;
              let isGiftTier = false;
              let matchingTier = null;
              
              // Extract threshold amount from span text
              const spans = icon.querySelectorAll('span');
              spans.forEach(span => {
                const spanText = span.textContent.trim();
                const dollarMatch = spanText.match(/\\$(\\d+(?:\\.\\d{2})?)/);
                if (dollarMatch) {
                  const dollarAmount = parseFloat(dollarMatch[1]);
                  iconThresholdAmount = dollarAmount * 100; // Convert to cents
                  
                  // Check if this is a gift tier
                  if (iconThresholdAmount === 8000) { // $80 Silver
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 8000);
                  } else if (iconThresholdAmount === 7000) { // $70 - Legacy fallback, treat as Silver
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 8000); // Map to $80 Silver tier
                  } else if (iconThresholdAmount === 10000) { // $100 Gold
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 10000);
                  } else if (iconThresholdAmount === 12000) { // $120 Gold (updated threshold)
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 10000); // Still maps to $100 Gold tier config
                  } else {
                    // Check if this threshold matches any configured gift tier
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === iconThresholdAmount);
                    if (matchingTier) {
                      isGiftTier = true;
                    }
                  }
                  
                  return; // Break out of span loop
                }
              });
              
              // If this is a gift tier icon, make it clickable
              if (isGiftTier && matchingTier) {
                const cartTotal = lastKnownCartTotal || 0;
                const isTierEligible = cartTotal >= matchingTier.thresholdAmount;
                
                if (isTierEligible) {
                  icon.style.cursor = 'pointer';
                  icon.title = matchingTier.name + ' - Click to select gifts';
                  
                  // Remove existing click handlers
                  const existingHandler = icon.getAttribute('data-gwp-click-handler');
                  if (existingHandler) {
                    icon.removeEventListener('click', window[existingHandler]);
                  }
                  
                  // Create unique click handler for this icon
                  const handlerName = 'gwpIconClick_' + matchingTier.id + '_' + Date.now();
                  window[handlerName] = function(event) {
                    event.stopPropagation(); // Prevent triggering the container click
                    console.log('GWP Debug: ' + matchingTier.name + ' icon clicked, showing modal for ONLY this tier');
                    
                    // Clear any dismissal flags
                    sessionStorage.removeItem('gwp_modal_dismissed');
                    sessionStorage.removeItem('gwp_modal_dismissed_time');
                    sessionStorage.removeItem('gwp_modal_dismissal_type');
                    
                    // Show modal for this specific tier ONLY
                    setTimeout(() => {
                      showGWPModalForSpecificTier(matchingTier);
                    }, 100);
                  };
                  
                  // Add click handler
                  icon.addEventListener('click', window[handlerName]);
                  icon.setAttribute('data-gwp-click-handler', handlerName);
                  
                  console.log('GWP Debug: Made ' + matchingTier.name + ' icon clickable');
                } else {
                  console.log('GWP Debug: ' + matchingTier.name + ' tier not yet eligible (cart: ' + cartTotal + ', threshold: ' + matchingTier.thresholdAmount + ')');
                }
              } else {
                console.log('GWP Debug: Icon ' + index + ' is not a gift tier or no matching tier found');
              }
            } catch (iconError) {
              console.log('GWP Debug: Error making icon ' + index + ' clickable:', iconError);
            }
          });
        } catch (error) {
          console.log('GWP Debug: Error making progress icons clickable:', error);
        }
      }
      
      // Show modal for a specific tier only (when clicking individual tier icons)
      async function showGWPModalForSpecificTier(specificTier) {
        try {
          if (isModalOpen) {
            console.log('GWP Debug: Modal already open, skipping specific tier modal...');
            return;
          }
          
          console.log('GWP Debug: Showing modal for specific tier only:', specificTier.name);
          
          // Check if modal already exists
          const existingModal = document.getElementById(GWP_MODAL_ID);
          if (existingModal) {
            console.log('GWP Debug: Modal already exists, removing...');
            existingModal.remove();
          }
          
          isModalOpen = true;
          addStyles();
          
          // Create modal with loading state
          document.body.insertAdjacentHTML('beforeend', \`
            <div class="gwp-modal-overlay active" id="\${GWP_MODAL_ID}">
              <div class="gwp-modal">
                <div class="gwp-modal-header">
                  <button class="gwp-modal-close" onclick="\${closeModalFunctionName}()">&times;</button>
                  <h2 class="gwp-modal-title">\${specificTier.name.toUpperCase()} GIFTS 🎁</h2>
                  <p class="gwp-modal-subtitle">Select your \${specificTier.name} gift. Cannot Be Combined With Other Discounts*</p>
                </div>
                <div class="gwp-modal-body">
                  <div class="gwp-loading">Loading your \${specificTier.name} gifts...</div>
                </div>
              </div>
            </div>
          \`);
          
          // Add interaction tracking to prevent refreshes during user interaction
          const modalElement = document.getElementById(GWP_MODAL_ID);
          if (modalElement) {
            // Track when user starts interacting
            modalElement.addEventListener('mouseenter', () => {
              userInteracting = true;
              console.log('GWP Debug: User started interacting with specific tier modal');
            });
            
            modalElement.addEventListener('mouseleave', () => {
              // Delay setting userInteracting to false to prevent immediate refreshes
              setTimeout(() => {
                userInteracting = false;
                console.log('GWP Debug: User stopped interacting with specific tier modal');
              }, 2000);
            });
            
            // Also track clicks and focus events
            modalElement.addEventListener('click', () => {
              userInteracting = true;
              // Reset the interaction timer
              setTimeout(() => {
                userInteracting = false;
              }, 3000);
            });
          }
          
          console.log('GWP Debug: Specific tier modal HTML created, fetching products...');
          
          try {
            // Fetch products for this specific tier only
            let tierProducts = [];
            if (specificTier.collectionHandle) {
              console.log('GWP Debug: Fetching products for specific tier:', specificTier.name, 'collection:', specificTier.collectionHandle);
              tierProducts = await fetchCollectionProducts(specificTier.collectionHandle);
              console.log('GWP Debug: Products for specific tier', specificTier.name, ':', tierProducts);
            } else {
              console.log('GWP Debug: No collection handle for specific tier:', specificTier.name);
            }
            
            // Check what gifts are already in cart for this specific tier
            const tierGiftsInCart = cartData?.items?.filter(item => {
              const hasGWPProperty = item.properties && (
                // Cart modal tier identification
                item.properties._gwp_tier_id === specificTier.id ||
                item.properties['_gwp_tier_id'] === specificTier.id ||
                item.properties._gwp_tier === specificTier.name ||
                item.properties['_gwp_tier'] === specificTier.name ||
                // Checkout extension tier identification
                item.properties._gift_tier_id === specificTier.id ||
                item.properties['_gift_tier_id'] === specificTier.id
              );
              return hasGWPProperty;
            }) || [];
            
            const maxSelections = specificTier.maxSelections || 1;
            const remainingSelections = maxSelections - tierGiftsInCart.length;
            const isMaxedOut = remainingSelections <= 0;
            
            // Update modal with products for this specific tier only
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
            if (modalBody) {
              if (tierProducts.length === 0) {
                modalBody.innerHTML = \`
                  <div class="gwp-error">
                    <h3>No \${specificTier.name} gifts available</h3>
                    <p>We're sorry, but there are no \${specificTier.name} gift products available at this time. Please contact support if you believe this is an error.</p>
                    <p><strong>Debug info:</strong> Collection handle: \${specificTier.collectionHandle || 'none'}</p>
                  </div>
                \`;
              } else {
                modalBody.innerHTML = \`
                  <div class="gwp-tier-section">
                    <h3 class="gwp-tier-title">
                      \${specificTier.name} - \${specificTier.description}
                      \${isMaxedOut ? ' ✅ ' : ' (' + remainingSelections + ' remaining)'}
                    </h3>
                    \${tierGiftsInCart.length > 0 ? \`
                      <div style="margin-bottom: 16px;">
                        <div class="gwp-products-grid">
                          \${tierGiftsInCart.map(gift => {
                            // Fix image URL - handle different image property formats
                            let imageUrl = null;
                            
                            // Try different image property formats
                            if (gift.featured_image) {
                              imageUrl = typeof gift.featured_image === 'string' ? gift.featured_image : gift.featured_image.url || gift.featured_image.src;
                            } else if (gift.image) {
                              imageUrl = typeof gift.image === 'string' ? gift.image : gift.image.url || gift.image.src;
                            } else if (gift.featured_image_url) {
                              imageUrl = typeof gift.featured_image_url === 'string' ? gift.featured_image_url : gift.featured_image_url.url || gift.featured_image_url.src;
                            }
                            
                            // If no image URL found, try to find the product in our fetched products
                            if (!imageUrl && gift.variant_id) {
                              const matchingProduct = tierProducts.find(p => p.variantId === gift.variant_id.toString());
                              if (matchingProduct) {
                                imageUrl = matchingProduct.image;
                              }
                            }
                            
                            // Final fallback
                            if (!imageUrl) {
                              imageUrl = \`https://via.placeholder.com/80x80/cccccc/666666?text=\${encodeURIComponent(gift.title || 'Gift')}\`;
                            }
                            
                            return \`
                              <div class="gwp-product-card selected" style="position: relative; border-color: #28a745; background-color: #f8fff8;">
                                <button onclick="\${removeGiftFunctionName}('\${gift.variant_id}', '\${specificTier.id}')" 
                                        style="position: absolute; top: 4px; right: 4px; background: #dc3545; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10;"
                                        title="Remove this gift">×</button>
                                <img src="\${imageUrl}" alt="\${gift.title}" class="gwp-product-image" />
                                <h5 class="gwp-product-title">\${gift.title}</h5>
                                <p class="gwp-product-free" style="color: #28a745;">SELECTED ✓</p>
                              </div>
                            \`;
                          }).join('')}
                        </div>
                      </div>
                    \` : ''}
                    \${tierProducts.length > 0 && !isMaxedOut ? \`
                      <div>
                        <strong style="display: block; margin-bottom: 8px; color: #0161FE;">Available \${specificTier.name} Gifts:</strong>
                        <div class="gwp-products-grid">
                          \${tierProducts.map(product => \`
                            <div class="gwp-product-card" onclick="\${selectProductFunctionName}('\${product.variantId}', '\${specificTier.id}', this)">
                              <img src="\${product.image}" alt="\${product.title}" class="gwp-product-image" />
                              <h5 class="gwp-product-title">\${product.title}</h5>
                              <p class="gwp-product-price">$\${(parseInt(product.price) / 100).toFixed(2)}</p>
                              <p class="gwp-product-free">FREE</p>
                            </div>
                          \`).join('')}
                        </div>
                      </div>
                    \` : tierGiftsInCart.length === 0 && tierProducts.length === 0 ? \`
                      
                    \` : ''}
                  </div>
                \`;
              }
              
              // Add footer
              const modal = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal\`);
              if (modal) {
                modal.insertAdjacentHTML('beforeend', \`
                  <div class="gwp-modal-footer">
                    <button class="gwp-button gwp-button-secondary" onclick="\${dismissModalFunctionName}()">Continue shopping</button>
                    <button class="gwp-button gwp-button-primary" id="gwp-add-to-cart-btn-\${GWP_NAMESPACE}" onclick="\${addToCartFunctionName}()" disabled>Add to cart (0)</button>
                  </div>
                \`);
              }
              
              console.log('GWP Debug: Specific tier modal content updated successfully');
            }
          } catch (error) {
            console.error('GWP Debug: Error loading gift products for specific tier:', error);
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
            if (modalBody) {
              modalBody.innerHTML = '<div class="gwp-error">Error loading gifts. Please try again.</div>';
            }
          }
        } catch (error) {
          console.error('GWP Debug: Error showing specific tier modal:', error);
          isModalOpen = false;
        }
      }
      
      // Update progress bar icons with selected gift images
      function updateProgressBarIcons() {
        try {
          console.log('GWP Debug: Updating progress bar icons with selected gifts...');
          
          if (!cartData || !cartData.items || !gwpConfig) {
            console.log('GWP Debug: No cart data or config available for progress bar icon update');
            return;
          }
          
          // Find progress bar container
          const progressBarContainer = document.querySelector('.custom-progress-bar-container');
          if (!progressBarContainer) {
            console.log('GWP Debug: Progress bar container not found');
            return;
          }
          
          // Look for progress icons with various possible selectors
          const iconSelectors = [
            '.custom-progress-icon.complete',
            '.progress-icon.complete',
            '.progress-step.complete',
            '.tier-icon.complete',
            '.gwp-icon.complete',
            '[data-tier-complete="true"]',
            '.progress-bar-icon.complete',
            '.step-complete'
          ];
          
          let progressIcons = [];
          for (const selector of iconSelectors) {
            const icons = progressBarContainer.querySelectorAll(selector);
            if (icons.length > 0) {
              progressIcons = Array.from(icons);
              console.log('GWP Debug: Found progress icons with selector:', selector, 'count:', icons.length);
              break;
            }
          }
          
          if (progressIcons.length === 0) {
            console.log('GWP Debug: No progress icons found to update');
            return;
          }
          
          console.log('GWP Debug: Progress icons found:', progressIcons.length);
          progressIcons.forEach((icon, index) => {
            console.log('GWP Debug: Icon ' + index + ':', {
              id: icon.id,
              classes: icon.className,
              style: icon.getAttribute('style'),
              innerHTML: icon.innerHTML.substring(0, 100) + '...'
            });
          });
          
          // Get gifts in cart organized by tier - Enhanced detection
          const giftsByTier = {};
          cartData.items.forEach(item => {
            console.log('GWP Debug: Checking cart item:', {
              title: item.title,
              variant_id: item.variant_id,
              properties: item.properties,
              featured_image: item.featured_image,
              image: item.image
            });
            
            if (item.properties) {
              // Check for tier identification with comprehensive property checking
              let tierId = null;
              let tierName = null;
              
              // Cart modal tier identification
              if (item.properties._gwp_tier_id || item.properties['_gwp_tier_id']) {
                tierId = item.properties._gwp_tier_id || item.properties['_gwp_tier_id'];
                console.log('GWP Debug: Found cart modal tier ID:', tierId);
              }
              if (item.properties._gwp_tier || item.properties['_gwp_tier']) {
                tierName = item.properties._gwp_tier || item.properties['_gwp_tier'];
                console.log('GWP Debug: Found cart modal tier name:', tierName);
              }
              
              // Checkout extension tier identification
              if (item.properties._gift_tier_id || item.properties['_gift_tier_id']) {
                tierId = item.properties._gift_tier_id || item.properties['_gift_tier_id'];
                console.log('GWP Debug: Found checkout extension tier ID:', tierId);
              }
              
              // Additional property checks for robustness
              if (item.properties.gwp_tier_id || item.properties['gwp_tier_id']) {
                tierId = item.properties.gwp_tier_id || item.properties['gwp_tier_id'];
                console.log('GWP Debug: Found gwp_tier_id:', tierId);
              }
              
              // Check if this is a gift item at all
              const isGiftItem = item.properties._gwp_gift === 'true' || 
                               item.properties['_gwp_gift'] === 'true' ||
                               item.properties.gwp_gift === 'true' ||
                               item.properties['gwp_gift'] === 'true' ||
                               item.properties._gift_with_purchase === 'true' ||
                               item.properties['_gift_with_purchase'] === 'true' ||
                               item.price === 0 || 
                               item.final_price === 0;
              
              console.log('GWP Debug: Is gift item:', isGiftItem, 'tierId:', tierId, 'tierName:', tierName);
              
              // If we found a tier, add this gift
              if (isGiftItem && (tierId || tierName)) {
                const tierKey = tierId || tierName;
                if (!giftsByTier[tierKey]) {
                  giftsByTier[tierKey] = [];
                }
                
                // Enhanced image URL extraction to match Shopify cart structure
                let imageUrl = null;
                
                // Method 1: Check featured_image (most common in Shopify cart)
                if (item.featured_image) {
                  if (typeof item.featured_image === 'string') {
                    imageUrl = item.featured_image;
                  } else if (item.featured_image.url) {
                    imageUrl = item.featured_image.url;
                  } else if (item.featured_image.src) {
                    imageUrl = item.featured_image.src;
                  }
                  console.log('GWP Debug: Found featured_image:', imageUrl);
                }
                
                // Method 2: Check image property
                if (!imageUrl && item.image) {
                  if (typeof item.image === 'string') {
                    imageUrl = item.image;
                  } else if (item.image.url) {
                    imageUrl = item.image.url;
                  } else if (item.image.src) {
                    imageUrl = item.image.src;
                  }
                  console.log('GWP Debug: Found image:', imageUrl);
                }
                
                // Method 3: Check variant image
                if (!imageUrl && item.variant_image) {
                  if (typeof item.variant_image === 'string') {
                    imageUrl = item.variant_image;
                  } else if (item.variant_image.url) {
                    imageUrl = item.variant_image.url;
                  } else if (item.variant_image.src) {
                    imageUrl = item.variant_image.src;
                  }
                  console.log('GWP Debug: Found variant_image:', imageUrl);
                }
                
                // Method 4: Check other possible image properties
                if (!imageUrl) {
                  const imageProps = ['featured_image_url', 'product_image', 'variant_featured_image'];
                  for (const prop of imageProps) {
                    if (item[prop]) {
                      if (typeof item[prop] === 'string') {
                        imageUrl = item[prop];
                      } else if (item[prop].url) {
                        imageUrl = item[prop].url;
                      } else if (item[prop].src) {
                        imageUrl = item[prop].src;
                      }
                      if (imageUrl) {
                        console.log('GWP Debug: Found image via', prop, ':', imageUrl);
                        break;
                      }
                    }
                  }
                }
                
                // Method 5: Try to construct image URL from variant ID if we have it
                if (!imageUrl && item.variant_id) {
                  // This is a fallback - we might need to fetch product data
                  console.log('GWP Debug: No direct image found, variant_id available:', item.variant_id);
                }
                
                console.log('GWP Debug: Final image URL for gift:', imageUrl);
                
                giftsByTier[tierKey].push({
                  title: item.title,
                  image: imageUrl,
                  variantId: item.variant_id,
                  tierId: tierId,
                  tierName: tierName,
                  cartItem: item // Store full cart item for debugging
                });
                
                console.log('GWP Debug: Added gift to tier', tierKey, ':', {
                  title: item.title,
                  image: imageUrl ? imageUrl.substring(0, 50) + '...' : 'No image',
                  tierId: tierId,
                  tierName: tierName
                });
              } else if (isGiftItem) {
                console.log('GWP Debug: Found gift item but no tier identification:', item.title);
              }
            }
          });
          
          console.log('GWP Debug: Gifts by tier for progress bar:', giftsByTier);
          
          // Sort tiers by threshold to match progress bar order
          const sortedTiers = [...gwpConfig].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
          console.log('GWP Debug: Sorted tiers for icon mapping:', sortedTiers.map(t => ({ 
            name: t.name, 
            id: t.id, 
            threshold: t.thresholdAmount,
            thresholdDollars: t.thresholdAmount / 100
          })));
          
          // Enhanced icon mapping logic
          progressIcons.forEach((icon, index) => {
            try {
              console.log('GWP Debug: Processing progress icon ' + index + ' with ID: ' + icon.id);
              
              let iconThresholdAmount = null; // Declare here in the correct scope
              let isGiftTier = false;
              let matchingTier = null;
              let tierGifts = [];
              
              // Extract threshold amount from span text
              const spans = icon.querySelectorAll('span');
              spans.forEach(span => {
                const spanText = span.textContent.trim();
                console.log('GWP Debug: Found span text: "' + spanText + '"');
                
                const dollarMatch = spanText.match(/\\$(\\d+(?:\\.\\d{2})?)/);
                if (dollarMatch) {
                  const dollarAmount = parseFloat(dollarMatch[1]);
                  iconThresholdAmount = dollarAmount * 100; // Convert to cents
                  console.log('GWP Debug: Extracted threshold amount: ' + iconThresholdAmount + ' cents from "' + spanText + '"');
                  
                  // Map thresholds to gift tiers based on cart drawer structure
                  // $59.99 = Free shipping (not a gift tier)
                  // $70 = Legacy threshold, now treat as $80 Silver tier (fallback)
                  // $80 = Silver tier (Silver)
                  // $100 = Gold tier (Gold)
                  if (iconThresholdAmount === 8000) { // $80
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 8000);
                    console.log('GWP Debug: This is the $80 gift tier (Silver)', matchingTier);
                  } else if (iconThresholdAmount === 7000) { // $70 - Legacy fallback, treat as Silver
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 8000); // Map to $80 Silver tier
                    console.log('GWP Debug: This is the legacy $70 icon, treating as $80 Silver tier', matchingTier);
                  } else if (iconThresholdAmount === 10000) { // $100
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 10000);
                    console.log('GWP Debug: This is the $100 gift tier (Gold)', matchingTier);
                  } else if (iconThresholdAmount === 12000) { // $120
                    isGiftTier = true;
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === 10000); // Still maps to $100 Gold tier config
                    console.log('GWP Debug: This is the $120 gift tier (Gold)', matchingTier);
                  } else {
                    // Check if this threshold matches any configured gift tier
                    matchingTier = gwpConfig.find(tier => tier.thresholdAmount === iconThresholdAmount);
                    if (matchingTier) {
                      isGiftTier = true;
                      console.log('GWP Debug: This matches configured gift tier: ' + matchingTier.name);
                    } else {
                      isGiftTier = false;
                      console.log('GWP Debug: This is not a configured gift tier: ' + iconThresholdAmount + ' cents');
                    }
                  }
                  
                  // Break out of the span loop once we find a threshold
                  return;
                }
              });
              
              console.log('GWP Debug: Final values for icon ' + index + ': iconThresholdAmount=' + iconThresholdAmount + ', isGiftTier=' + isGiftTier + ', matchingTier=', matchingTier);
              
              // Skip this icon if it's not a gift tier
              if (iconThresholdAmount && !isGiftTier) {
                console.log('GWP Debug: Skipping non-gift tier icon with threshold: ' + iconThresholdAmount + ' cents');
                return; // Skip this iteration
              }
              
              // If no threshold was found, this icon is not a gift tier
              if (!iconThresholdAmount) {
                console.log('GWP Debug: Icon ' + index + ' is not a gift tier (threshold: null)');
                return;
              }
              
              // Get gifts for the matching tier - try multiple tier key formats
              if (matchingTier) {
                // Try tier ID first
                if (giftsByTier[matchingTier.id]) {
                  tierGifts = giftsByTier[matchingTier.id];
                  console.log('GWP Debug: Found ' + tierGifts.length + ' gifts for tier ID: ' + matchingTier.id);
                }
                // Try tier name as fallback
                else if (giftsByTier[matchingTier.name]) {
                  tierGifts = giftsByTier[matchingTier.name];
                  console.log('GWP Debug: Found ' + tierGifts.length + ' gifts for tier name: ' + matchingTier.name);
                }
                // Try alternative tier names
                else {
                  const alternativeKeys = ['Silver', 'Gold', 'Free Gift', 'Tier 2'];
                  for (const key of alternativeKeys) {
                    if (giftsByTier[key]) {
                      tierGifts = giftsByTier[key];
                      console.log('GWP Debug: Found ' + tierGifts.length + ' gifts for alternative key: ' + key);
                      break;
                    }
                  }
                }
              }
              
              // Update the icon based on whether gifts are selected
              if (matchingTier && tierGifts.length > 0) {
                // Use the first gift's image for the icon
                const firstGift = tierGifts[0];
                console.log('GWP Debug: First gift for tier ' + matchingTier.name + ':', firstGift);
                if (firstGift.image) {
                  console.log('GWP Debug: Updating progress icon ' + index + ' (ID: ' + icon.id + ') with gift image: ' + firstGift.title + ' for tier: ' + matchingTier.name);
                  
                  // Update the icon with the selected gift image
                  updateProgressIcon(icon, firstGift.image, firstGift.title, matchingTier.name);
                } else {
                  console.log('GWP Debug: No image available for gift: ' + firstGift.title);
                  console.log('GWP Debug: Full gift object:', firstGift);
                  
                  // Try to extract image from the full cart item
                  if (firstGift.cartItem) {
                    console.log('GWP Debug: Trying to extract image from full cart item:', firstGift.cartItem);
                    // Additional image extraction attempts could go here
                  }
                }
              } else if (matchingTier) {
                // Show default tier icon even when no gifts are selected
                console.log('GWP Debug: Showing default tier icon for ' + matchingTier.name + ' (no gifts selected yet)');
                // Keep the existing icon but add tier information
                icon.title = matchingTier.name + ' - Click to select gifts';
                icon.style.cursor = 'pointer';
              } else if (isGiftTier) {
                console.log('GWP Debug: Gift tier icon found but no matching tier configuration');
              } else {
                console.log('GWP Debug: Icon ' + index + ' is not a gift tier (threshold: ' + iconThresholdAmount + ')');
              }
            } catch (iconError) {
              console.log('GWP Debug: Error updating progress icon ' + index + ':', iconError);
            }
          });
        } catch (error) {
          console.log('GWP Debug: Error updating progress bar icons:', error);
        }
      }
      
      // Update a single progress icon with gift image
      function updateProgressIcon(iconElement, imageUrl, giftTitle, tierName) {
        try {
          console.log('GWP Debug: updateProgressIcon called with:', {
            iconElement: iconElement,
            imageUrl: imageUrl,
            giftTitle: giftTitle,
            tierName: tierName
          });
          
          // Store original content if not already stored
          if (!iconElement.hasAttribute('data-original-content')) {
            iconElement.setAttribute('data-original-content', iconElement.innerHTML);
            console.log('GWP Debug: Stored original icon content');
          }
          
          // Method 1: Replace with image if icon contains an img element
          const existingImg = iconElement.querySelector('img');
          if (existingImg) {
            console.log('GWP Debug: Found existing img element, updating src');
            existingImg.src = imageUrl;
            existingImg.alt = giftTitle;
            existingImg.title = 'Selected gift: ' + giftTitle + ' (' + tierName + ')';
            console.log('GWP Debug: Updated existing img in progress icon');
            return;
          }
          
          // Method 2: Always replace the content with the gift image for progress icons
          console.log('GWP Debug: No existing img found, replacing icon content with gift image');
          iconElement.innerHTML = \`<img src="\${imageUrl}" alt="\${giftTitle}" title="Selected gift: \${giftTitle} (\${tierName})" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%; border: 2px solid #0161FE;">\`;
          console.log('GWP Debug: Successfully replaced progress icon content with gift image');
          
        } catch (error) {
          console.log('GWP Debug: Error updating individual progress icon:', error);
        }
      }
      
      // Reset progress icon to default state
      function resetProgressIcon(iconElement) {
        try {
          const originalContent = iconElement.getAttribute('data-original-content');
          if (originalContent) {
            iconElement.innerHTML = originalContent;
          }
          
          // Clear any background styles
          iconElement.style.backgroundImage = '';
          iconElement.style.backgroundSize = '';
          iconElement.style.backgroundPosition = '';
          iconElement.style.backgroundRepeat = '';
          iconElement.title = '';
          
          console.log('GWP Debug: Reset progress icon to default state');
        } catch (error) {
          console.log('GWP Debug: Error resetting progress icon:', error);
        }
      }
      
      // Event-based cart monitoring to avoid conflicts
      function setupCartMonitoring() {
        console.log('GWP Debug: Setting up cart monitoring...');
        
        // Clear any existing monitoring first
        if (cartMonitorInterval) {
          clearInterval(cartMonitorInterval);
          cartMonitorInterval = null;
        }
        
        // Debounce mechanism to prevent excessive refreshes
        let refreshTimeout = null;
        let lastRefreshTime = 0;
        let userInteracting = false;
        
        function debouncedRefresh() {
          console.log('GWP Debug: debouncedRefresh called');
          
          if (refreshTimeout) {
            clearTimeout(refreshTimeout);
          }
          
          // Prevent refreshing if user is actively interacting with modal
          if (isModalOpen && userInteracting) {
            console.log('GWP Debug: Skipping refresh - user is interacting with modal');
            return;
          }
          
          // Reduced minimum refresh interval for faster auto-show response
          const now = Date.now();
          const timeSinceLastRefresh = now - lastRefreshTime;
          const minRefreshInterval = 3000; // Reduced to 3 seconds for faster response
          
          if (timeSinceLastRefresh < minRefreshInterval) {
            console.log('GWP Debug: Skipping refresh - too soon since last refresh');
            return;
          }
          
          refreshTimeout = setTimeout(async () => {
            try {
              console.log('GWP Debug: Executing debounced refresh...');
              
              // Don't refresh if modal is open and user has selected gifts
              if (isModalOpen && selectedGifts.length > 0) {
                console.log('GWP Debug: Skipping refresh - user has selected gifts in modal');
                return;
              }
              
              lastRefreshTime = Date.now();
              
              console.log('GWP Debug: Fetching cart data...');
              await fetchCartData();
              
              // Update progress bar icons with selected gifts
              setTimeout(() => {
                updateProgressBarIcons();
              }, 500);
              
              // Only refresh modal if it's open and user isn't actively selecting
              if (isModalOpen && !userInteracting) {
                console.log('GWP Debug: Refreshing modal content...');
                await window[refreshModalFunctionName]();
              }
              
              // Only check eligibility if modal is not open
              if (!isModalOpen) {
                console.log('GWP Debug: Modal not open, checking gift eligibility...');
                checkGiftEligibility();
              } else {
                console.log('GWP Debug: Modal is open, skipping eligibility check');
              }
            } catch (error) {
              console.log('GWP Debug: Error in debounced refresh:', error);
            }
          }, 1000); // Reduced delay to 1 second for faster response
        }
        
        // Immediate eligibility check for faster auto-show response
        function immediateEligibilityCheck() {
          console.log('GWP Debug: Immediate eligibility check triggered');
          
          // Don't check if modal is already open
          if (isModalOpen) {
            console.log('GWP Debug: Modal already open, skipping immediate check');
            return;
          }
          
          // Quick check without debouncing for faster response
          setTimeout(async () => {
            try {
              console.log('GWP Debug: Executing immediate eligibility check...');
              await fetchCartData();
              
              // Check eligibility immediately
              checkGiftEligibility();
              
              // Also update progress bar
              setTimeout(() => {
                updateProgressBarIcons();
                makeProgressBarClickable();
              }, 300);
            } catch (error) {
              console.log('GWP Debug: Error in immediate eligibility check:', error);
            }
          }, 200); // Very fast response
        }
        
        // Wrap event handlers in try-catch to prevent theme conflicts
        function safeEventHandler(eventName, handler) {
          return function(event) {
            try {
              // Skip events that come from theme handlers to avoid conflicts
              if (event.detail && event.detail.source === 'theme') {
                console.log('GWP Debug: Skipping theme-generated event:', eventName);
                return;
              }
              
              console.log('GWP Debug: Cart event detected:', eventName, event);
              handler();
            } catch (error) {
              console.log('GWP Debug: Error handling', eventName, 'event:', error);
            }
          };
        }
        
        // Listen for Shopify cart events - with immediate checks for auto-show
        document.addEventListener('cart:updated', safeEventHandler('cart:updated', () => {
          // Immediate check for auto-show
          immediateEligibilityCheck();
          
          // Also do the regular debounced refresh
          debouncedRefresh();
          setTimeout(makeProgressBarClickable, 500);
          setTimeout(makeProgressBarClickable, 1500);
          setTimeout(() => {
            console.log('GWP Debug: Updating progress bar icons from cart:updated event');
            updateProgressBarIcons();
          }, 1800);
          setTimeout(() => {
            console.log('GWP Debug: Second progress bar icon update from cart:updated event');
            updateProgressBarIcons();
          }, 3500);
        }));
        
        // Listen for cart events with immediate eligibility checks
        const cartEvents = ['cart:change', 'cart:added', 'cart:removed'];
        cartEvents.forEach(eventName => {
          document.addEventListener(eventName, safeEventHandler(eventName, () => {
            // Immediate check for auto-show
            immediateEligibilityCheck();
            
            // Also do the regular debounced refresh
            debouncedRefresh();
            setTimeout(makeProgressBarClickable, 500);
            setTimeout(makeProgressBarClickable, 1500);
            setTimeout(() => {
              console.log('GWP Debug: Updating progress bar icons from ' + eventName + ' event');
              updateProgressBarIcons();
            }, 1800);
            setTimeout(() => {
              console.log('GWP Debug: Second progress bar icon update from ' + eventName + ' event');
              updateProgressBarIcons();
            }, 3500);
          }));
        });
        
        // Also listen for more cart-related events that might indicate threshold changes
        const additionalCartEvents = [
          'cart:refresh',
          'cart:build',
          'cart:requestComplete',
          'cart:requestStarted',
          'shopify:cart:update',
          'theme:cart:update',
          'drawer:updated'
        ];
        
        additionalCartEvents.forEach(eventName => {
          document.addEventListener(eventName, safeEventHandler(eventName, () => {
            console.log('GWP Debug: Additional cart event detected:', eventName);
            immediateEligibilityCheck();
          }));
        });
        
        // Monitor for cart drawer opening/closing with better error handling
        const cartDrawerSelectors = [
          '[data-cart-drawer]',
          '.cart-drawer',
          '.js-cart-drawer',
          '#cart-drawer',
          '.drawer--cart'
        ];
        
        cartDrawerSelectors.forEach(selector => {
          try {
            const drawer = document.querySelector(selector);
            if (drawer) {
              // Use MutationObserver to watch for class changes (open/close) - but be more selective
              const observer = new MutationObserver(function(mutations) {
                try {
                  let shouldRefresh = false;
                  mutations.forEach(function(mutation) {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                      // Only trigger if the drawer is being opened/closed, not just any class change
                      const target = mutation.target;
                      if (target.classList.contains('is-open') || 
                          target.classList.contains('open') || 
                          target.classList.contains('active') ||
                          target.classList.contains('drawer--is-open')) {
                        shouldRefresh = true;
                      }
                    }
                  });
                  
                  if (shouldRefresh) {
                    console.log('GWP Debug: Cart drawer opened/closed, checking eligibility');
                    immediateEligibilityCheck();
                    debouncedRefresh();
                  }
                } catch (observerError) {
                  console.log('GWP Debug: Error in mutation observer:', observerError);
                }
              });
              observer.observe(drawer, { attributes: true, attributeFilter: ['class'] });
              
              // Remove the content observer that was causing conflicts
              // The aggressive content monitoring was triggering theme errors
            }
          } catch (selectorError) {
            console.log('GWP Debug: Error setting up observer for', selector, ':', selectorError);
          }
        });
        
        // Add a periodic fallback check to ensure we don't miss threshold changes
        // This is less aggressive than before but provides a safety net
        const periodicCheck = setInterval(async () => {
          try {
            // Only do periodic checks if modal is not open
            if (!isModalOpen) {
              console.log('GWP Debug: Periodic eligibility check (fallback)');
              
              // Get current cart total
              const currentTotal = await getCartTotal();
              
              // Only check if cart total has changed significantly
              if (Math.abs(currentTotal - lastKnownCartTotal) > 100) { // More than $1 change
                console.log('GWP Debug: Cart total changed significantly, checking eligibility');
                console.log('GWP Debug: Previous total:', lastKnownCartTotal, 'Current total:', currentTotal);
                lastKnownCartTotal = currentTotal;
                
                // Check eligibility
                immediateEligibilityCheck();
              }
            }
          } catch (error) {
            console.log('GWP Debug: Error in periodic check:', error);
          }
        }, 15000); // Check every 15 seconds as fallback
        
        // Store the interval ID for cleanup
        window.gwpPeriodicCheckInterval = periodicCheck;
        
        // Also check when page becomes visible (user switches back to tab)
        document.addEventListener('visibilitychange', safeEventHandler('visibilitychange', () => {
          if (!document.hidden) {
            console.log('GWP Debug: Page became visible, checking cart');
            immediateEligibilityCheck();
            debouncedRefresh();
          }
        }));
      }
      
      // Show modal
      async function showGWPModal() {
        try {
          if (isModalOpen) {
            console.log('GWP Debug: Modal already open, skipping...');
            return;
          }
          
          console.log('GWP Debug: Checking gift eligibility for modal...');
          const eligibleTiers = await checkGiftEligibilityWithCartCheck();
          if (eligibleTiers.length === 0) {
            console.log('GWP Debug: No eligible tiers, not showing modal');
            return;
          }
          
          console.log('GWP Debug: Showing modal for', eligibleTiers.length, 'eligible tiers');
          console.log('GWP Debug: Tier details:', eligibleTiers.map(t => ({ name: t.name, collectionHandle: t.collectionHandle })));
          
          // Check if modal already exists
          const existingModal = document.getElementById(GWP_MODAL_ID);
          if (existingModal) {
            console.log('GWP Debug: Modal already exists, removing...');
            existingModal.remove();
          }
        
        isModalOpen = true;
        addStyles();
        
        // Create modal with loading state
        document.body.insertAdjacentHTML('beforeend', \`
            <div class="gwp-modal-overlay active" id="\${GWP_MODAL_ID}">
            <div class="gwp-modal">
              <div class="gwp-modal-header">
                  <button class="gwp-modal-close" onclick="\${closeModalFunctionName}()">&times;</button>
                <h2 class="gwp-modal-title">CONGRATULATIONS 🎉</h2>
                <p class="gwp-modal-subtitle">You Earned A Free Gift! Cannot Be Combined With Other Discounts*</p>
              </div>
              <div class="gwp-modal-body">
                <div class="gwp-loading">Loading your free gifts...</div>
              </div>
            </div>
          </div>
        \`);
          
          // Add interaction tracking to prevent refreshes during user interaction
          const modalElement = document.getElementById(GWP_MODAL_ID);
          if (modalElement) {
            // Track when user starts interacting
            modalElement.addEventListener('mouseenter', () => {
              userInteracting = true;
              console.log('GWP Debug: User started interacting with modal');
            });
            
            modalElement.addEventListener('mouseleave', () => {
              // Delay setting userInteracting to false to prevent immediate refreshes
              setTimeout(() => {
                userInteracting = false;
                console.log('GWP Debug: User stopped interacting with modal');
              }, 2000);
            });
            
            // Also track clicks and focus events
            modalElement.addEventListener('click', () => {
              userInteracting = true;
              // Reset the interaction timer
              setTimeout(() => {
                userInteracting = false;
              }, 3000);
            });
          }
          
          console.log('GWP Debug: Modal HTML created, fetching products...');
        
        try {
          // Fetch products for each tier
          const tierProducts = await Promise.all(
              eligibleTiers.map(async tier => {
                if (tier.collectionHandle) {
                  console.log('GWP Debug: Fetching products for tier:', tier.name, 'collection:', tier.collectionHandle);
                  const products = await fetchCollectionProducts(tier.collectionHandle);
                  console.log('GWP Debug: Products for tier', tier.name, ':', products);
                  return products;
                } else {
                  console.log('GWP Debug: No collection handle for tier:', tier.name);
                  return [];
                }
              })
            );
            
            console.log('GWP Debug: Products fetched for tiers:', tierProducts);
          
          // Update modal with products
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
          if (modalBody) {
              const hasAnyProducts = tierProducts.some(products => products.length > 0);
              
              if (!hasAnyProducts) {
                modalBody.innerHTML = \`
                  <div class="gwp-error">
                    <h3>No gifts available</h3>
                    <p>We're sorry, but there are no gift products available at this time. Please contact support if you believe this is an error.</p>
                    <p><strong>Debug info:</strong> Collection handles: \${eligibleTiers.map(t => t.collectionHandle || 'none').join(', ')}</p>
                  </div>
                \`;
              } else {
            modalBody.innerHTML = eligibleTiers.map((tier, tierIndex) => \`
              <div class="gwp-tier-section">
                <h3 class="gwp-tier-title">\${tier.name} - \${tier.description}</h3>
                    \${(tierProducts[tierIndex] || []).length > 0 ? \`
                <div class="gwp-products-grid">
                  \${(tierProducts[tierIndex] || []).map(product => \`
                          <div class="gwp-product-card" onclick="\${selectProductFunctionName}('\${product.variantId}', '\${tier.id}', this)">
                      <img src="\${product.image}" alt="\${product.title}" class="gwp-product-image" />
                      <h5 class="gwp-product-title">\${product.title}</h5>
                      <p class="gwp-product-price">$\${(parseInt(product.price) / 100).toFixed(2)}</p>
                      <p class="gwp-product-free">FREE</p>
                    </div>
                  \`).join('')}
                </div>
                    \` : \`
                      
                    \`}
              </div>
            \`).join('');
              }
            
            // Add footer
              const modal = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal\`);
              if (modal) {
            modal.insertAdjacentHTML('beforeend', \`
              <div class="gwp-modal-footer">
                    <button class="gwp-button gwp-button-secondary" onclick="\${dismissModalFunctionName}()">Continue shopping</button>
                    <button class="gwp-button gwp-button-primary" id="gwp-add-to-cart-btn-\${GWP_NAMESPACE}" onclick="\${addToCartFunctionName}()" disabled>Add to cart (0)</button>
              </div>
              <div class="gwp-fine-print">
                *Free gifts cannot be combined with other discount codes or promotional offers
              </div>
            \`);
              }
              
              console.log('GWP Debug: Modal content updated successfully');
          }
        } catch (error) {
            console.error('GWP Debug: Error loading gift products:', error);
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
          if (modalBody) {
            modalBody.innerHTML = '<div class="gwp-error">Error loading gifts. Please try again.</div>';
          }
          }
        } catch (error) {
          console.error('GWP Debug: Error showing modal:', error);
          isModalOpen = false;
        }
      }
      
      // Show modal for progress bar clicks - shows ALL eligible tiers
      async function showGWPModalForProgressBar() {
        try {
          if (isModalOpen) {
            console.log('GWP Debug: Modal already open, skipping progress bar modal...');
            return;
          }
          
          console.log('GWP Debug: Checking gift eligibility for progress bar modal...');
          const eligibleTiers = await checkGiftEligibilityForProgressBar();
          if (eligibleTiers.length === 0) {
            console.log('GWP Debug: No eligible tiers for progress bar, not showing modal');
            return;
          }
          
          console.log('GWP Debug: Showing progress bar modal for', eligibleTiers.length, 'eligible tiers');
          console.log('GWP Debug: Progress bar tier details:', eligibleTiers.map(t => ({ name: t.name, collectionHandle: t.collectionHandle })));
          
          // Check if modal already exists
          const existingModal = document.getElementById(GWP_MODAL_ID);
          if (existingModal) {
            console.log('GWP Debug: Modal already exists, removing...');
            existingModal.remove();
          }
          
          isModalOpen = true;
          addStyles();
          
          // Create modal with loading state
          document.body.insertAdjacentHTML('beforeend', \`
            <div class="gwp-modal-overlay active" id="\${GWP_MODAL_ID}">
              <div class="gwp-modal">
                <div class="gwp-modal-header">
                  <button class="gwp-modal-close" onclick="\${closeModalFunctionName}()">&times;</button>
                  <h2 class="gwp-modal-title">YOUR FREE GIFTS 🎁</h2>
                  <p class="gwp-modal-subtitle">Manage your gift selections. Cannot Be Combined With Other Discounts*</p>
                </div>
                <div class="gwp-modal-body">
                  <div class="gwp-loading">Loading your gift options...</div>
                </div>
              </div>
            </div>
          \`);
          
          // Add interaction tracking to prevent refreshes during user interaction
          const modalElement = document.getElementById(GWP_MODAL_ID);
          if (modalElement) {
            // Track when user starts interacting
            modalElement.addEventListener('mouseenter', () => {
              userInteracting = true;
              console.log('GWP Debug: User started interacting with progress bar modal');
            });
            
            modalElement.addEventListener('mouseleave', () => {
              // Delay setting userInteracting to false to prevent immediate refreshes
              setTimeout(() => {
                userInteracting = false;
                console.log('GWP Debug: User stopped interacting with progress bar modal');
              }, 2000);
            });
            
            // Also track clicks and focus events
            modalElement.addEventListener('click', () => {
              userInteracting = true;
              // Reset the interaction timer
              setTimeout(() => {
                userInteracting = false;
              }, 3000);
            });
          }
          
          console.log('GWP Debug: Progress bar modal HTML created, fetching products...');
          
          try {
            // Fetch products for each tier
            const tierProducts = await Promise.all(
              eligibleTiers.map(async tier => {
                if (tier.collectionHandle) {
                  console.log('GWP Debug: Fetching products for progress bar tier:', tier.name, 'collection:', tier.collectionHandle);
                  const products = await fetchCollectionProducts(tier.collectionHandle);
                  console.log('GWP Debug: Products for progress bar tier', tier.name, ':', products);
                  return products;
                } else {
                  console.log('GWP Debug: No collection handle for progress bar tier:', tier.name);
                  return [];
                }
              })
            );
            
            console.log('GWP Debug: Products fetched for progress bar tiers:', tierProducts);
            
            // Check what gifts are already in cart for each tier
            const tierGiftsStatus = eligibleTiers.map(tier => {
              const tierGiftsInCart = cartData?.items?.filter(item => {
                const hasGWPProperty = item.properties && (
                  // Cart modal tier identification
                  item.properties._gwp_tier_id === tier.id ||
                  item.properties['_gwp_tier_id'] === tier.id ||
                  item.properties._gwp_tier === tier.name ||
                  item.properties['_gwp_tier'] === tier.name ||
                  // Checkout extension tier identification
                  item.properties._gift_tier_id === tier.id ||
                  item.properties['_gift_tier_id'] === tier.id
                );
                return hasGWPProperty;
              }) || [];
              
              const maxSelections = tier.maxSelections || 1;
              const remainingSelections = maxSelections - tierGiftsInCart.length;
              
              return {
                tier,
                giftsInCart: tierGiftsInCart,
                remainingSelections,
                isMaxedOut: remainingSelections <= 0
              };
            });
            
            // Update modal with products
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
            if (modalBody) {
              const hasAnyProducts = tierProducts.some(products => products.length > 0);
              
              if (!hasAnyProducts) {
                modalBody.innerHTML = \`
                  <div class="gwp-error">
                    <h3>No gifts available</h3>
                    <p>We're sorry, but there are no gift products available at this time. Please contact support if you believe this is an error.</p>
                    <p><strong>Debug info:</strong> Collection handles: \${eligibleTiers.map(t => t.collectionHandle || 'none').join(', ')}</p>
                  </div>
                \`;
              } else {
                modalBody.innerHTML = tierGiftsStatus.map((tierStatus, tierIndex) => {
                  const tier = tierStatus.tier;
                  const products = tierProducts[tierIndex] || [];
                  
                  return \`
                    <div class="gwp-tier-section">
                      <h3 class="gwp-tier-title">
                        \${tier.name} - \${tier.description}
                        \${tierStatus.isMaxedOut ? ' ✅ ' : ' (' + tierStatus.remainingSelections + ' remaining)'}
                      </h3>
                      \${tierStatus.giftsInCart.length > 0 ? \`
                        <div style="margin-bottom: 16px;">
                          <div class="gwp-products-grid">
                            \${tierStatus.giftsInCart.map(gift => {
                              // Fix image URL - handle different image property formats
                              let imageUrl = null;
                              
                              // Try different image property formats
                              if (gift.featured_image) {
                                imageUrl = typeof gift.featured_image === 'string' ? gift.featured_image : gift.featured_image.url || gift.featured_image.src;
                              } else if (gift.image) {
                                imageUrl = typeof gift.image === 'string' ? gift.image : gift.image.url || gift.image.src;
                              } else if (gift.featured_image_url) {
                                imageUrl = typeof gift.featured_image_url === 'string' ? gift.featured_image_url : gift.featured_image_url.url || gift.featured_image_url.src;
                              }
                              
                              // If no image URL found, try to construct one from variant data
                              if (!imageUrl && gift.variant_id) {
                                // Try to find the product in our fetched products
                                const matchingProduct = products.find(p => p.variantId === gift.variant_id.toString());
                                if (matchingProduct) {
                                  imageUrl = matchingProduct.image;
                                }
                              }
                              
                              // Final fallback
                              if (!imageUrl) {
                                imageUrl = \`https://via.placeholder.com/80x80/cccccc/666666?text=\${encodeURIComponent(gift.title || 'Gift')}\`;
                              }
                              
                              return \`
                                <div class="gwp-product-card selected" style="position: relative; border-color: #28a745; background-color: #f8fff8;">
                                  <button onclick="\${removeGiftFunctionName}('\${gift.variant_id}', '\${tier.id}')" 
                                          style="position: absolute; top: 4px; right: 4px; background: #dc3545; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10;"
                                          title="Remove this gift">×</button>
                                  <img src="\${imageUrl}" alt="\${gift.title}" class="gwp-product-image" />
                                  <h5 class="gwp-product-title">\${gift.title}</h5>
                                  <p class="gwp-product-free" style="color: #28a745;">SELECTED ✓</p>
                                </div>
                              \`;
                            }).join('')}
                          </div>
                        </div>
                      \` : \`
                        
                      \`}
                      \${products.length > 0 && !tierStatus.isMaxedOut ? \`
                        <div>
                          <strong style="display: block; margin-bottom: 8px; color: #0161FE;">Available Gifts:</strong>
                          <div class="gwp-products-grid">
                            \${products.map(product => \`
                              <div class="gwp-product-card" onclick="\${selectProductFunctionName}('\${product.variantId}', '\${tier.id}', this)">
                                <img src="\${product.image}" alt="\${product.title}" class="gwp-product-image" />
                                <h5 class="gwp-product-title">\${product.title}</h5>
                                <p class="gwp-product-price">$\${(parseInt(product.price) / 100).toFixed(2)}</p>
                                <p class="gwp-product-free">FREE</p>
                              </div>
                            \`).join('')}
                          </div>
                        </div>
                      \` : tierStatus.giftsInCart.length === 0 && products.length === 0 ? \`
                        
                      \` : ''}
                    </div>
                  \`;
                }).join('');
              }
              
              // Add footer
              const modal = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal\`);
              if (modal) {
                modal.insertAdjacentHTML('beforeend', \`
                  <div class="gwp-modal-footer">
                    <button class="gwp-button gwp-button-secondary" onclick="\${dismissModalFunctionName}()">Continue shopping</button>
                    <button class="gwp-button gwp-button-primary" id="gwp-add-to-cart-btn-\${GWP_NAMESPACE}" onclick="\${addToCartFunctionName}()" disabled>Add to cart (0)</button>
                  </div>
                  <div class="gwp-fine-print">
                    *Free gifts cannot be combined with other discount codes or promotional offers
                  </div>
                \`);
              }
              
              console.log('GWP Debug: Progress bar modal content updated successfully');
            }
          } catch (error) {
            console.error('GWP Debug: Error loading gift products for progress bar:', error);
            const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
            if (modalBody) {
              modalBody.innerHTML = '<div class="gwp-error">Error loading gifts. Please try again.</div>';
            }
          }
        } catch (error) {
          console.error('GWP Debug: Error showing progress bar modal:', error);
          isModalOpen = false;
        }
      }
      
      // Initialize with better error handling
      async function initGWP() {
        try {
        console.log('GWP Debug: Initializing cart modal...');
          
          // Fetch configuration first
        gwpConfig = await fetchGWPConfig();
        console.log('GWP Debug: Configuration loaded:', gwpConfig);
        
          if (!gwpConfig || gwpConfig.length === 0) {
            console.log('GWP Debug: No GWP configuration found, exiting...');
            return;
          }
          
          // Get initial cart data
          lastKnownCartTotal = await getCartTotal();
          console.log('GWP Debug: Initial cart total:', lastKnownCartTotal / 100);
          
          // Setup event-based monitoring
          setupCartMonitoring();
          
          // Make progress bar clickable
        setTimeout(() => {
            makeProgressBarClickable();
          }, 2000); // Wait a bit for the progress bar to be rendered
          
          // Additional attempts to make progress bar clickable
          setTimeout(() => {
            makeProgressBarClickable();
          }, 5000);
          
          setTimeout(() => {
            makeProgressBarClickable();
          }, 12000);
          
          // Immediate initial eligibility check for auto-show
          setTimeout(() => {
            console.log('GWP Debug: Initial immediate eligibility check');
            checkGiftEligibility();
          }, 1000);
          
          // Additional immediate checks at different intervals
          setTimeout(() => {
            console.log('GWP Debug: Second immediate eligibility check');
            checkGiftEligibility();
          }, 3000);
          
          setTimeout(() => {
            console.log('GWP Debug: Third immediate eligibility check');
            checkGiftEligibility();
          }, 6000);
          
          // Single initial check to avoid spam
          setTimeout(() => {
            console.log('GWP Debug: Initial setup check');
            fetchCartData().then(() => {
              updateProgressBarIcons();
              makeProgressBarClickable();
              
              // Additional eligibility check after cart data is loaded
              setTimeout(() => {
                console.log('GWP Debug: Post-cart-data eligibility check');
                checkGiftEligibility();
              }, 500);
            });
          }, 3000);
          
          // Update progress bar icons on initialization
          setTimeout(() => {
            updateProgressBarIcons();
            makeProgressBarClickable();
          }, 3000); // Wait a bit longer to ensure cart data is loaded
          
          // Initial checks with longer delays to avoid conflicts
          setTimeout(() => {
            console.log('GWP Debug: Initial check #1 at 2000ms');
            fetchCartData().then(() => {
              updateProgressBarIcons();
              makeProgressBarClickable();
              setTimeout(() => {
                console.log('GWP Debug: Second progress bar icon update after cart data fetch');
                updateProgressBarIcons();
                makeProgressBarClickable();
              }, 1000);
            });
          }, 2000);
          
          setTimeout(() => {
            console.log('GWP Debug: Initial check #2 at 8000ms');
            fetchCartData().then(() => {
              updateProgressBarIcons();
              makeProgressBarClickable();
              
              // Final eligibility check
              setTimeout(() => {
                console.log('GWP Debug: Final initialization eligibility check');
                checkGiftEligibility();
              }, 1000);
            });
          }, 8000);
          
          setTimeout(() => {
            console.log('GWP Debug: Initial check #3 at 15000ms');
            fetchCartData().then(() => {
              makeProgressBarClickable();
              
              // Last eligibility check
              setTimeout(() => {
                console.log('GWP Debug: Last initialization eligibility check');
                checkGiftEligibility();
              }, 1000);
            });
          }, 15000);
          
        } catch (error) {
          console.error('GWP Debug: Error initializing GWP:', error);
        }
      }
      
      // Cleanup function with unique name
      window[\`cleanupGWP_\${GWP_NAMESPACE}\`] = function() {
        try {
          if (cartMonitorInterval) {
            clearInterval(cartMonitorInterval);
            cartMonitorInterval = null;
          }
          
          // Clear periodic check interval
          if (window.gwpPeriodicCheckInterval) {
            clearInterval(window.gwpPeriodicCheckInterval);
            window.gwpPeriodicCheckInterval = null;
          }
          
          const modal = document.getElementById(GWP_MODAL_ID);
          if (modal) {
            modal.remove();
          }
          isModalOpen = false;
          
          // Restore original theme functions if they were modified
          if (originalCheckForGift && window.checkForGift !== originalCheckForGift) {
            window.checkForGift = originalCheckForGift;
            console.log('GWP Debug: Restored original checkForGift function during cleanup');
          }
          
          // Clean up global functions
          delete window[selectProductFunctionName];
          delete window[addToCartFunctionName];
          delete window[closeModalFunctionName];
          delete window[dismissModalFunctionName];
          delete window[removeGiftFunctionName];
          delete window[refreshModalFunctionName];
          delete window[\`cleanupGWP_\${GWP_NAMESPACE}\`];
        } catch (error) {
          console.log('GWP Debug: Error during cleanup:', error);
        }
      };
      
      // Create a simple alias for closing the modal
      window.closeGWPModal = window[closeModalFunctionName];
      
      // Create a global function to force refresh cart and check eligibility
      window.gwpForceRefresh = async function() {
        try {
          console.log('GWP Debug: Force refresh triggered');
          await fetchCartData();
          setTimeout(checkGiftEligibility, 500);
        } catch (error) {
          console.log('GWP Debug: Error in force refresh:', error);
        }
      };
      
      // Create a global function to manually trigger eligibility check
      window.gwpCheckEligibility = function() {
        console.log('GWP Debug: Manual eligibility check triggered');
        setTimeout(checkGiftEligibility, 100);
      };
      
      // Create a global function to clear all dismissal flags for testing
      window.gwpClearDismissal = function() {
        console.log('GWP Debug: Clearing all dismissal flags');
        sessionStorage.removeItem('gwp_modal_dismissed');
        sessionStorage.removeItem('gwp_modal_dismissed_time');
        sessionStorage.removeItem('gwp_modal_dismissal_type');
        console.log('GWP Debug: Dismissal flags cleared');
      };
      
      // Create a global function to check dismissal status
      window.gwpCheckDismissal = function() {
        const modalDismissed = sessionStorage.getItem('gwp_modal_dismissed');
        const dismissedTime = sessionStorage.getItem('gwp_modal_dismissed_time');
        const dismissalType = sessionStorage.getItem('gwp_modal_dismissal_type');
        
        console.log('GWP Debug: Current dismissal status:', {
          dismissed: modalDismissed,
          time: dismissedTime ? new Date(parseInt(dismissedTime)).toLocaleString() : 'none',
          type: dismissalType,
          wasRecentlyDismissed: wasRecentlyDismissed()
        });
      };
      
      // Create a global function to manually show modal for testing
      window.gwpTestModal = async function() {
        console.log('GWP Debug: Manual test modal triggered');
        try {
          // Force fetch cart data first
          await fetchCartData();
          
          // Force show modal regardless of eligibility for testing
          if (!gwpConfig || gwpConfig.length === 0) {
            console.log('GWP Debug: No config available for test');
            return;
          }
          
          // Show modal with first tier for testing
          const testTier = gwpConfig[0];
          console.log('GWP Debug: Testing with tier:', testTier);
          
          // Temporarily override eligibility check
          const originalCheck = checkGiftEligibilityWithCartCheck;
          window.checkGiftEligibilityWithCartCheck = async () => [testTier];
          
          // Show modal
          await showGWPModal();
          
          // Restore original function
          window.checkGiftEligibilityWithCartCheck = originalCheck;
        } catch (error) {
          console.log('GWP Debug: Error in test modal:', error);
        }
      };
      
      // Remove gift from cart function
      window[removeGiftFunctionName] = async function(cartItemKey, tierId) {
        try {
          console.log('GWP Debug: Removing gift from cart:', cartItemKey, 'tier:', tierId);
          
          // Temporarily disable cart monitoring to prevent extra refreshes
          let wasMonitoringActive = cartMonitorInterval !== null;
          if (cartMonitorInterval) {
            clearInterval(cartMonitorInterval);
            cartMonitorInterval = null;
          }
          
          // Refresh cart data first to get current state
          await fetchCartData();
          
          // Try to find the cart item to get the correct identifier
          let itemToRemove = null;
          if (cartData && cartData.items) {
            // First try to find by the exact key passed
            itemToRemove = cartData.items.find(item => item.key === cartItemKey);
            
            if (!itemToRemove) {
              // Try to find by variant_id (extract from compound key if needed)
              let variantId = cartItemKey;
              if (cartItemKey.includes(':')) {
                variantId = cartItemKey.split(':')[0];
              }
              
              itemToRemove = cartData.items.find(item => 
                item.variant_id.toString() === variantId.toString() ||
                item.id.toString() === variantId.toString()
              );
            }
            
            if (!itemToRemove) {
              // Try to find by tier ID if direct match fails
              itemToRemove = cartData.items.find(item => {
                const hasGWPProperty = item.properties && (
                  item.properties._gwp_tier_id === tierId ||
                  item.properties['_gwp_tier_id'] === tierId ||
                  item.properties._gift_tier_id === tierId ||
                  item.properties['_gift_tier_id'] === tierId
                );
                return hasGWPProperty;
              });
            }
            
            if (itemToRemove) {
              console.log('GWP Debug: Found cart item to remove:', {
                key: itemToRemove.key,
                id: itemToRemove.id,
                variant_id: itemToRemove.variant_id,
                title: itemToRemove.title
              });
          } else {
              console.log('GWP Debug: Cart item not found for removal:', cartItemKey);
              console.log('GWP Debug: Available cart items:', cartData.items.map(item => ({
                key: item.key,
                id: item.id,
                variant_id: item.variant_id,
                title: item.title
              })));
              
              // Re-enable monitoring before returning
              if (wasMonitoringActive) {
                setupCartMonitoring();
              }
              return;
            }
          }
          
          // Use the cart item's key for removal (Shopify's preferred method)
          const itemKey = itemToRemove.key;
          
          console.log('GWP Debug: Attempting to remove item with key:', itemKey);
          
          const response = await fetch('/cart/change.js', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              id: itemKey,
              quantity: 0
            })
          });
          
          if (response.ok) {
            console.log('GWP Debug: Successfully removed gift from cart');
            
            // Refresh cart data immediately
            await fetchCartData();
            
            // Only refresh modal once if it's open
            if (isModalOpen) {
              console.log('GWP Debug: Refreshing modal after gift removal');
              await window[refreshModalFunctionName]();
            }
            
            // Re-enable monitoring after a delay to prevent immediate triggers
            setTimeout(() => {
              if (wasMonitoringActive) {
                setupCartMonitoring();
          }
        }, 2000);
            
          } else {
            const errorText = await response.text();
            console.error('GWP Debug: Error removing gift from cart:', response.status, errorText);
            
            // Try alternative removal method using line number
            if (itemToRemove && cartData.items) {
              const lineNumber = cartData.items.findIndex(item => item.key === itemToRemove.key) + 1;
              if (lineNumber > 0) {
                console.log('GWP Debug: Trying removal with line number:', lineNumber);
                
                const lineResponse = await fetch('/cart/change.js', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    line: lineNumber,
                    quantity: 0
                  })
                });
                
                if (lineResponse.ok) {
                  console.log('GWP Debug: Successfully removed gift using line number');
                  await fetchCartData();
                  
                  if (isModalOpen) {
                    await window[refreshModalFunctionName]();
                  }
                  
                  // Re-enable monitoring after a delay
                  setTimeout(() => {
                    if (wasMonitoringActive) {
                      setupCartMonitoring();
                    }
                  }, 2000);
                } else {
                  const lineErrorText = await lineResponse.text();
                  console.error('GWP Debug: Line number removal also failed:', lineResponse.status, lineErrorText);
                  
                  // Re-enable monitoring even if failed
                  if (wasMonitoringActive) {
                    setupCartMonitoring();
                  }
                }
              } else {
                // Re-enable monitoring if line number not found
                if (wasMonitoringActive) {
                  setupCartMonitoring();
                }
              }
            } else {
              // Re-enable monitoring if no item to remove
              if (wasMonitoringActive) {
                setupCartMonitoring();
              }
            }
          }
        } catch (error) {
          console.error('GWP Debug: Error removing gift from cart:', error);
          
          // Always re-enable monitoring in case of error
          setTimeout(() => {
            setupCartMonitoring();
          }, 2000);
        }
      };
      
      // Refresh modal content function
      window[refreshModalFunctionName] = async function() {
        try {
          console.log('GWP Debug: Refreshing modal content...');
          
          if (!isModalOpen) {
            console.log('GWP Debug: Modal not open, skipping refresh');
            return;
          }
          
          // Refresh cart data first
          await fetchCartData();
          
          // Check if we're in progress bar modal mode or regular modal mode
          const modalTitle = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-title\`);
          const isProgressBarModal = modalTitle && modalTitle.textContent.includes('YOUR FREE GIFTS');
          
          // Instead of closing and reopening, just update the content
          const modalBody = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-body\`);
          if (!modalBody) {
            console.log('GWP Debug: Modal body not found, modal may have been closed');
            return;
          }
          
          // Show loading state
          modalBody.innerHTML = '<div class="gwp-loading">Updating your gifts...</div>';
          
          if (isProgressBarModal) {
            // Update progress bar modal content
            const eligibleTiers = await checkGiftEligibilityForProgressBar();
            if (eligibleTiers.length === 0) {
              console.log('GWP Debug: No eligible tiers after refresh, closing modal');
              window[closeModalFunctionName]();
              return;
            }
            
            // Fetch products for each tier
            const tierProducts = await Promise.all(
              eligibleTiers.map(async tier => {
                if (tier.collectionHandle) {
                  const products = await fetchCollectionProducts(tier.collectionHandle);
                  return products;
                } else {
                  return [];
                }
              })
            );
            
            // Check what gifts are already in cart for each tier
            const tierGiftsStatus = eligibleTiers.map(tier => {
              const tierGiftsInCart = cartData?.items?.filter(item => {
                const hasGWPProperty = item.properties && (
                  // Cart modal tier identification
                  item.properties._gwp_tier_id === tier.id ||
                  item.properties['_gwp_tier_id'] === tier.id ||
                  item.properties._gwp_tier === tier.name ||
                  item.properties['_gwp_tier'] === tier.name ||
                  // Checkout extension tier identification
                  item.properties._gift_tier_id === tier.id ||
                  item.properties['_gift_tier_id'] === tier.id
                );
                return hasGWPProperty;
              }) || [];
              
              const maxSelections = tier.maxSelections || 1;
              const remainingSelections = maxSelections - tierGiftsInCart.length;
              
              return {
                tier,
                giftsInCart: tierGiftsInCart,
                remainingSelections,
                isMaxedOut: remainingSelections <= 0
              };
            });
            
            // Update modal body content
            modalBody.innerHTML = tierGiftsStatus.map((tierStatus, tierIndex) => {
              const tier = tierStatus.tier;
              const products = tierProducts[tierIndex] || [];
              
              return \`
                <div class="gwp-tier-section">
                  <h3 class="gwp-tier-title">
                    \${tier.name} - \${tier.description}
                    \${tierStatus.isMaxedOut ? ' ✅ ' : ' (' + tierStatus.remainingSelections + ' remaining)'}
                  </h3>
                  \${tierStatus.giftsInCart.length > 0 ? \`
                    <div style="margin-bottom: 16px;">
                      <div class="gwp-products-grid">
                        \${tierStatus.giftsInCart.map(gift => {
                          // Fix image URL - handle different image property formats
                          let imageUrl = null;
                          
                          // Try different image property formats
                          if (gift.featured_image) {
                            imageUrl = typeof gift.featured_image === 'string' ? gift.featured_image : gift.featured_image.url || gift.featured_image.src;
                          } else if (gift.image) {
                            imageUrl = typeof gift.image === 'string' ? gift.image : gift.image.url || gift.image.src;
                          } else if (gift.featured_image_url) {
                            imageUrl = typeof gift.featured_image_url === 'string' ? gift.featured_image_url : gift.featured_image_url.url || gift.featured_image_url.src;
                          }
                          
                          // If no image URL found, try to construct one from variant data
                          if (!imageUrl && gift.variant_id) {
                            // Try to find the product in our fetched products
                            const matchingProduct = products.find(p => p.variantId === gift.variant_id.toString());
                            if (matchingProduct) {
                              imageUrl = matchingProduct.image;
                            }
                          }
                          
                          // Final fallback
                          if (!imageUrl) {
                            imageUrl = \`https://via.placeholder.com/80x80/cccccc/666666?text=\${encodeURIComponent(gift.title || 'Gift')}\`;
                          }
                          
                          return \`
                            <div class="gwp-product-card selected" style="position: relative; border-color: #28a745; background-color: #f8fff8;">
                              <button onclick="\${removeGiftFunctionName}('\${gift.variant_id}', '\${tier.id}')" 
                                      style="position: absolute; top: 4px; right: 4px; background: #dc3545; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10;"
                                      title="Remove this gift">×</button>
                              <img src="\${imageUrl}" alt="\${gift.title}" class="gwp-product-image" />
                              <h5 class="gwp-product-title">\${gift.title}</h5>
                              <p class="gwp-product-free" style="color: #28a745;">SELECTED ✓</p>
                            </div>
                          \`;
                        }).join('')}
                      </div>
                    </div>
                  \` : ''}
                  \${products.length > 0 && !tierStatus.isMaxedOut ? \`
                    <div>
                      <strong style="display: block; margin-bottom: 8px; color: #0161FE;">Available Gifts:</strong>
                      <div class="gwp-products-grid">
                        \${products.map(product => \`
                          <div class="gwp-product-card" onclick="\${selectProductFunctionName}('\${product.variantId}', '\${tier.id}', this)">
                            <img src="\${product.image}" alt="\${product.title}" class="gwp-product-image" />
                            <h5 class="gwp-product-title">\${product.title}</h5>
                            <p class="gwp-product-price">$\${(parseInt(product.price) / 100).toFixed(2)}</p>
                            <p class="gwp-product-free">FREE</p>
                          </div>
                        \`).join('')}
                      </div>
                    </div>
                  \` : tierStatus.giftsInCart.length === 0 && products.length === 0 ? \`
                    
                  \` : ''}
                </div>
              \`;
            }).join('');
            
          } else {
            // Update regular modal content
            const eligibleTiers = await checkGiftEligibilityWithCartCheck();
            if (eligibleTiers.length === 0) {
              console.log('GWP Debug: No eligible tiers after refresh, closing modal');
              window[closeModalFunctionName]();
              return;
            }
            
            // Fetch products for each tier
            const tierProducts = await Promise.all(
              eligibleTiers.map(async tier => {
                if (tier.collectionHandle) {
                  const products = await fetchCollectionProducts(tier.collectionHandle);
                  return products;
                } else {
                  return [];
                }
              })
            );
            
            const hasAnyProducts = tierProducts.some(products => products.length > 0);
            
            if (!hasAnyProducts) {
              modalBody.innerHTML = \`
                <div class="gwp-error">
                  <h3>No gifts available</h3>
                  <p>We're sorry, but there are no gift products available at this time. Please contact support if you believe this is an error.</p>
                  <p><strong>Debug info:</strong> Collection handles: \${eligibleTiers.map(t => t.collectionHandle || 'none').join(', ')}</p>
                </div>
              \`;
            } else {
              modalBody.innerHTML = eligibleTiers.map((tier, tierIndex) => \`
                <div class="gwp-tier-section">
                  <h3 class="gwp-tier-title">\${tier.name} - \${tier.description}</h3>
                  \${(tierProducts[tierIndex] || []).length > 0 ? \`
                    <div class="gwp-products-grid">
                      \${(tierProducts[tierIndex] || []).map(product => \`
                        <div class="gwp-product-card" onclick="\${selectProductFunctionName}('\${product.variantId}', '\${tier.id}', this)">
                          <img src="\${product.image}" alt="\${product.title}" class="gwp-product-image" />
                          <h5 class="gwp-product-title">\${product.title}</h5>
                          <p class="gwp-product-price">$\${(parseInt(product.price) / 100).toFixed(2)}</p>
                          <p class="gwp-product-free">FREE</p>
                        </div>
                      \`).join('')}
                    </div>
                  \` : \`
                    
                  \`}
                </div>
              \`).join('');
            }
          }
          
          // Ensure footer exists and is not duplicated
          let existingFooter = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal-footer\`);
          if (!existingFooter) {
            const modal = document.querySelector(\`#\${GWP_MODAL_ID} .gwp-modal\`);
            if (modal) {
              modal.insertAdjacentHTML('beforeend', \`
                <div class="gwp-modal-footer">
                  <button class="gwp-button gwp-button-secondary" onclick="\${dismissModalFunctionName}()">Continue shopping</button>
                  <button class="gwp-button gwp-button-primary" id="gwp-add-to-cart-btn-\${GWP_NAMESPACE}" onclick="\${addToCartFunctionName}()" disabled>Add to cart (0)</button>
                </div>
                <div class="gwp-fine-print">
                  *Free gifts cannot be combined with other discount codes or promotional offers
                </div>
              \`);
            }
          }
          
          // Reset selected gifts and update button
          selectedGifts = [];
          updateAddToCartButton();
          
          console.log('GWP Debug: Modal content refreshed successfully');
          
        } catch (error) {
          console.log('GWP Debug: Error refreshing modal content:', error);
        }
      };
      
      // Start when DOM is ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGWP);
      } else {
        initGWP();
      }
      
      // Cleanup on page unload
      window.addEventListener('beforeunload', window[\`cleanupGWP_\${GWP_NAMESPACE}\`]);
      
      console.log('GWP Debug: Cart modal script setup complete');
      
      // Progress bar click handler function
      function progressBarClickHandler() {
        console.log('GWP Debug: Progress bar clicked, forcing modal to show');
        
        // Clear any dismissal flags temporarily
        const wasDismissed = sessionStorage.getItem('gwp_modal_dismissed');
        if (wasDismissed) {
          sessionStorage.removeItem('gwp_modal_dismissed');
          sessionStorage.removeItem('gwp_modal_dismissed_time');
          sessionStorage.removeItem('gwp_modal_dismissal_type');
        }
        
        // Force show modal with all eligible tiers (not just available ones)
        setTimeout(() => {
          showGWPModalForProgressBar();
        }, 100);
      }
      
      // Create a global function to update progress bar icons manually
      window.gwpUpdateProgressIcons = function() {
        console.log('GWP Debug: Manual progress bar icon update triggered');
        setTimeout(updateProgressBarIcons, 100);
      };
      
      // Create a global function to debug tier and gift selection issues
      window.gwpDebugTiers = function() {
        console.log('GWP Debug: === TIER DEBUG INFO ===');
        console.log('GWP Config:', gwpConfig);
        console.log('Cart Data:', cartData);
        
        if (cartData && cartData.items) {
          console.log('Cart Items with GWP properties:');
          cartData.items.forEach((item, index) => {
            if (item.properties) {
              const hasGWPProps = Object.keys(item.properties).some(key => 
                key.includes('gwp') || key.includes('gift')
              );
              if (hasGWPProps) {
                console.log(\`Item \${index}:\`, {
                  title: item.title,
                  variant_id: item.variant_id,
                  properties: item.properties
                });
              }
            }
          });
        }
        
        if (gwpConfig) {
          console.log('Tier Configuration:');
          gwpConfig.forEach(tier => {
            console.log(\`Tier \${tier.name}:\`, {
              id: tier.id,
              threshold: tier.thresholdAmount,
              thresholdDollars: tier.thresholdAmount / 100,
              collectionHandle: tier.collectionHandle,
              maxSelections: tier.maxSelections
            });
          });
        }
        
        console.log('Current cart total:', lastKnownCartTotal, 'cents =', lastKnownCartTotal / 100, 'dollars');
        console.log('=== END TIER DEBUG ===');
      };
      
      // Create a comprehensive debug function
      window.gwpDebugAll = function() {
        console.log('GWP Debug: === COMPREHENSIVE DEBUG INFO ===');
        console.log('GWP_CART_MODAL_LOADED:', window.GWP_CART_MODAL_LOADED);
        console.log('isModalOpen:', isModalOpen);
        console.log('userInteracting:', userInteracting);
        console.log('lastKnownCartTotal:', lastKnownCartTotal, 'cents =', lastKnownCartTotal / 100, 'dollars');
        console.log('selectedGifts:', selectedGifts);
        console.log('gwpConfig:', gwpConfig);
        console.log('cartData:', cartData);
        
        // Check dismissal status
        const modalDismissed = sessionStorage.getItem('gwp_modal_dismissed');
        const dismissedTime = sessionStorage.getItem('gwp_modal_dismissed_time');
        const dismissalType = sessionStorage.getItem('gwp_modal_dismissal_type');
        console.log('Dismissal status:', {
          dismissed: modalDismissed,
          time: dismissedTime ? new Date(parseInt(dismissedTime)).toLocaleString() : 'none',
          type: dismissalType,
          wasRecentlyDismissed: wasRecentlyDismissed()
        });
        
        // Check progress bar
        const progressBarContainer = document.querySelector('.custom-progress-bar-container');
        console.log('Progress bar container found:', !!progressBarContainer);
        if (progressBarContainer) {
          const progressIcons = progressBarContainer.querySelectorAll('.custom-progress-icon.complete');
          console.log('Progress icons found:', progressIcons.length);
          progressIcons.forEach((icon, index) => {
            console.log('GWP Debug: Icon ' + index + ':', {
              id: icon.id,
              classes: icon.className,
              style: icon.getAttribute('style'),
              innerHTML: icon.innerHTML.substring(0, 100) + '...'
            });
          });
        }
        
        // Check cart drawer elements
        const cartDrawerSelectors = [
          '[data-cart-drawer]',
          '.cart-drawer',
          '.js-cart-drawer',
          '#cart-drawer',
          '.drawer--cart'
        ];
        
        console.log('Cart drawer elements:');
        cartDrawerSelectors.forEach(selector => {
          const element = document.querySelector(selector);
          if (element) {
            console.log(\`Found \${selector}:\`, {
              classes: element.className,
              isOpen: element.classList.contains('is-open') || 
                     element.classList.contains('open') || 
                     element.classList.contains('active')
            });
          }
        });
        
        console.log('=== END COMPREHENSIVE DEBUG ===');
      };
      
      // Create a global function to test cart drawer opening
      window.gwpTestCartDrawer = function() {
        console.log('GWP Debug: Manual cart drawer test triggered');
        
        // Try to open cart drawer using the same logic as gift addition
        setTimeout(() => {
          try {
            console.log('GWP Debug: Testing cart drawer opening...');
            
            const cartDrawerTriggers = [
              '[data-cart-drawer-toggle]',
              '[data-drawer-toggle="cart"]',
              '.cart-drawer-toggle',
              '.js-cart-drawer-toggle',
              '.cart-icon-bubble',
              '.site-header__cart',
              '.header-cart-toggle',
              '[data-cart-toggle]:not([href*="/cart"])',
              '.js-cart-toggle:not([href*="/cart"])'
            ];
            
            console.log('GWP Debug: Looking for cart drawer triggers...');
            
            for (const selector of cartDrawerTriggers) {
              const trigger = document.querySelector(selector);
              if (trigger) {
                console.log('GWP Debug: Found cart trigger:', selector, trigger);
                if (typeof trigger.click === 'function') {
                  console.log('GWP Debug: Clicking cart trigger:', selector);
                  trigger.click();
                  console.log('GWP Debug: Cart trigger clicked successfully');
                  break;
                } else {
                  console.log('GWP Debug: Trigger found but no click function:', selector);
                }
              } else {
                console.log('GWP Debug: No trigger found for selector:', selector);
              }
            }
          } catch (error) {
            console.error('GWP Debug: Error testing cart drawer:', error);
          }
        }, 100);
      };
      
      // Create a simple function to test if cart drawer opening works at all
      window.gwpTestSimpleCartOpen = function() {
        console.log('GWP Debug: Simple cart open test');
        
        // Method 1: Use the cart-drawer custom element's show() method
        const cartDrawerElement = document.querySelector("cart-drawer");
        if (cartDrawerElement && typeof cartDrawerElement.show === 'function') {
          console.log('GWP Debug: Found cart-drawer element, calling show() method');
          cartDrawerElement.show();
          console.log('GWP Debug: Successfully called cart-drawer.show()');
          return true;
        }
        
        // Method 2: Try the cart-drawer ID selector
        const cartDrawerById = document.getElementById("cart-drawer");
        if (cartDrawerById && typeof cartDrawerById.show === 'function') {
          console.log('GWP Debug: Found cart-drawer by ID, calling show() method');
          cartDrawerById.show();
          console.log('GWP Debug: Successfully called cart-drawer.show() via ID');
          return true;
        }
        
        console.log('GWP Debug: No cart-drawer element found with show() method');
        return false;
      };
      
      // Create a comprehensive function to analyze all cart-related elements
      window.gwpAnalyzeCartElements = function() {
        console.log('GWP Debug: === COMPREHENSIVE CART ELEMENT ANALYSIS ===');
        
        // Check for cart drawers
        const cartDrawerSelectors = [
          '[data-cart-drawer]',
          '.cart-drawer',
          '.js-cart-drawer',
          '#cart-drawer',
          '.drawer--cart',
          '.cart-sidebar',
          '.mini-cart',
          '.cart-popup',
          '.drawer-cart'
        ];
        
        console.log('Cart Drawer Elements:');
        cartDrawerSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`  \${selector}: \${elements.length} found\`);
            elements.forEach((el, index) => {
              console.log(\`    [\${index}] Classes: \${el.className}\`);
              console.log(\`    [\${index}] ID: \${el.id}\`);
              console.log(\`    [\${index}] Style display: \${el.style.display}\`);
              console.log(\`    [\${index}] Computed display: \${window.getComputedStyle(el).display}\`);
            });
          }
        });
        
        // Check for cart triggers
        const cartTriggerSelectors = [
          '[data-cart-drawer-toggle]',
          '[data-drawer-toggle="cart"]',
          '.cart-drawer-toggle',
          '.js-cart-drawer-toggle',
          '.cart-icon-bubble',
          '.site-header__cart',
          '.header-cart-toggle',
          '[data-cart-toggle]',
          '.js-cart-toggle'
        ];
        
        console.log('Cart Trigger Elements:');
        cartTriggerSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`  \${selector}: \${elements.length} found\`);
            elements.forEach((el, index) => {
              console.log(\`    [\${index}] Tag: \${el.tagName}\`);
              console.log(\`    [\${index}] Classes: \${el.className}\`);
              console.log(\`    [\${index}] ID: \${el.id}\`);
              console.log(\`    [\${index}] Href: \${el.getAttribute('href')}\`);
              console.log(\`    [\${index}] Has click: \${typeof el.click === 'function'}\`);
            });
          }
        });
        
        // Check for theme-specific functions
        console.log('Theme Functions Available:');
        const themeFunctions = [
          'window.theme?.cart?.open',
          'window.Shopify?.theme?.cart?.open',
          'window.cartOpen',
          'window.openCart',
          'window.showCart',
          'window.toggleCart',
          'window.theme?.openCart',
          'window.theme?.showCart',
          'window.theme?.toggleCart',
          'window.drawer?.open',
          'window.theme?.drawer?.open'
        ];
        
        themeFunctions.forEach(funcPath => {
          try {
            const func = eval(funcPath);
            console.log(\`  \${funcPath}: \${typeof func === 'function' ? 'Available' : 'Not available'}\`);
          } catch (error) {
            console.log(\`  \${funcPath}: Error checking - \${error.message}\`);
          }
        });
        
        // Check for cart count elements
        console.log('Cart Count Elements:');
        const cartCountSelectors = [
          '[data-cart-count]',
          '.cart-count',
          '.cart__count',
          '.header__cart-count',
          '.cart-link__bubble',
          '.cart-count-bubble'
        ];
        
        cartCountSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(\`  \${selector}: \${elements.length} found\`);
            elements.forEach((el, index) => {
              console.log(\`    [\${index}] Text: "\${el.textContent}"\`);
              console.log(\`    [\${index}] Classes: \${el.className}\`);
            });
          }
        });
        
        console.log('=== END CART ELEMENT ANALYSIS ===');
      };
      
      // Create a function to test the shop domain detection
      window.gwpTestShopDomain = function() {
        console.log('GWP Debug: === SHOP DOMAIN DETECTION TEST ===');
        console.log('Current hostname:', window.location.hostname);
        console.log('Current href:', window.location.href);
        console.log('Current origin:', window.location.origin);
        
        // Test the API call
        const shopDomain = window.location.hostname;
        const apiUrl = \`https://gwp-2-5.vercel.app/api/public/gwp-settings?shop=\${encodeURIComponent(shopDomain)}\`;
        console.log('API URL that would be called:', apiUrl);
        
        // Make the actual API call to test
        fetch(apiUrl)
          .then(response => response.json())
          .then(data => {
            console.log('API Response:', data);
            if (data.tiers) {
              const tiers = JSON.parse(data.tiers);
              console.log('Parsed tiers:', tiers);
              tiers.forEach(tier => {
                console.log(\`Tier: \${tier.name}, Collection Handle: \${tier.collectionHandle || 'none'}\`);
              });
            }
          })
          .catch(error => {
            console.error('API Error:', error);
          });
        
        console.log('=== END SHOP DOMAIN TEST ===');
      };
      
      // Create a function to force test cart drawer opening with all methods
      window.gwpForceTestCartDrawer = function() {
        console.log('GWP Debug: === FORCE TESTING ALL CART DRAWER METHODS ===');
        
        // First analyze what's available
        window.gwpAnalyzeCartElements();
        
        // Then try each method systematically
        setTimeout(() => {
          console.log('Testing Method 1: Click triggers...');
          window.gwpTestCartDrawer();
        }, 1000);
        
        setTimeout(() => {
          console.log('Testing Method 2: Manual class manipulation...');
          const cartDrawerSelectors = [
            '[data-cart-drawer]',
            '.cart-drawer',
            '.js-cart-drawer',
            '#cart-drawer',
            '.drawer--cart'
          ];
          
          for (const selector of cartDrawerSelectors) {
            const drawer = document.querySelector(selector);
            if (drawer) {
              console.log('Manually opening drawer:', selector);
              drawer.classList.add('is-open', 'open', 'active', 'show', 'visible');
              drawer.classList.remove('is-closed', 'closed', 'inactive', 'hide', 'hidden');
              if (drawer.style.display === 'none') {
                drawer.style.display = 'block';
              }
              break;
            }
          }
        }, 2000);
        
        setTimeout(() => {
          console.log('Testing Method 3: Theme functions...');
          const themeFunctions = [
            () => window.theme?.cart?.open?.(),
            () => window.Shopify?.theme?.cart?.open?.(),
            () => window.cartOpen?.(),
            () => window.openCart?.(),
            () => window.showCart?.(),
            () => window.toggleCart?.()
          ];
          
          for (const func of themeFunctions) {
            try {
              const result = func();
              if (result !== undefined) {
                console.log('Successfully called theme function');
                break;
              }
            } catch (error) {
              // Continue
            }
          }
        }, 3000);
        
        console.log('=== END FORCE TEST ===');
      };
      
      // Debug function to check cart drawer availability
      window.gwpCheckCartDrawer = function() {
        console.log('GWP Debug: === CART DRAWER AVAILABILITY CHECK ===');
        
        // Check for cart-drawer element
        const cartDrawerElement = document.querySelector("cart-drawer");
        console.log('GWP Debug: cart-drawer element:', cartDrawerElement);
        
        if (cartDrawerElement) {
          console.log('GWP Debug: cart-drawer methods available:');
          console.log('  - show():', typeof cartDrawerElement.show);
          console.log('  - hide():', typeof cartDrawerElement.hide);
          console.log('  - toggle():', typeof cartDrawerElement.toggle);
          console.log('  - open():', typeof cartDrawerElement.open);
          console.log('  - close():', typeof cartDrawerElement.close);
          
          // Check current state
          console.log('GWP Debug: cart-drawer current classes:', cartDrawerElement.className);
          console.log('GWP Debug: cart-drawer current style.display:', cartDrawerElement.style.display);
        }
        
        // Check for cart-drawer by ID
        const cartDrawerById = document.getElementById("cart-drawer");
        console.log('GWP Debug: cart-drawer by ID:', cartDrawerById);
        
        if (cartDrawerById && cartDrawerById !== cartDrawerElement) {
          console.log('GWP Debug: Different element found by ID');
          console.log('GWP Debug: ID element methods:');
          console.log('  - show():', typeof cartDrawerById.show);
        }
        
        // List all elements with cart-drawer tag
        const allCartDrawers = document.querySelectorAll("cart-drawer");
        console.log('GWP Debug: Total cart-drawer elements found:', allCartDrawers.length);
        
        return {
          element: cartDrawerElement,
          hasShow: cartDrawerElement && typeof cartDrawerElement.show === 'function',
          count: allCartDrawers.length
        };
      };
      
      // Test function to manually update progress bar icons with sample images
      window.gwpTestProgressBarIcons = function() {
        console.log('GWP Debug: === TESTING PROGRESS BAR ICON UPDATES ===');
        
        // Sample gift images for testing
        const sampleGifts = {
          tier1: {
            image: 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-ProductImages-Sleeve-Black-1.png?v=1738446687',
            title: 'Black Sleeve',
            tierName: 'Silver'
          },
          tier2: {
            image: 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-Product_Images-Traveler_20oz-Orchid-1_2d93da96-c629-45a0-a74c-b5506e9d66d9.png?v=1738446687',
            title: 'Orchid Traveler',
            tierName: 'Gold'
          }
        };
        
        // Find progress icons
        const progressIcons = document.querySelectorAll('.custom-progress-icon');
        console.log('GWP Debug: Found', progressIcons.length, 'progress icons');
        
        progressIcons.forEach((icon, index) => {
          const spans = icon.querySelectorAll('span');
          let threshold = null;
          
          spans.forEach(span => {
            const spanText = span.textContent.trim();
            const dollarMatch = spanText.match(/\$(\d+(?:\.\d{2})?)/);
            if (dollarMatch) {
              threshold = parseFloat(dollarMatch[1]);
            }
          });
          
          console.log(\`GWP Debug: Icon \${index} threshold: $\${threshold}\`);
          
          // Update icons based on threshold
          if (threshold === 80 || threshold === 70) { // Handle both $80 and legacy $70 as Silver tier
            console.log('GWP Debug: Updating $' + threshold + ' icon with Silver tier gift');
            updateProgressIcon(icon, sampleGifts.tier1.image, sampleGifts.tier1.title, sampleGifts.tier1.tierName);
          } else if (threshold === 100) {
            console.log('GWP Debug: Updating $100 icon with Gold tier gift');
            updateProgressIcon(icon, sampleGifts.tier2.image, sampleGifts.tier2.title, sampleGifts.tier2.tierName);
          } else {
            console.log(\`GWP Debug: Skipping icon with threshold $\${threshold} (not a gift tier)\`);
          }
        });
        
        console.log('GWP Debug: Progress bar icon test completed');
      };
      
      // Test function for progress bar icon updates
      window.gwpTestProgressBarIcons = function() {
        console.log('GWP Debug: Testing progress bar icon updates...');
        
        // Sample gift data for testing
        const testGifts = {
          'tier1748560909689': [{
            title: 'Test Gift 1',
            image: 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-ProductImages-Sleeve-SweetCherry-1_400x.jpg',
            variantId: '12345',
            tierId: 'tier1748560909689',
            tierName: 'Free Gift'
          }],
          'tier1748560909690': [{
            title: 'Test Gift 2', 
            image: 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-ProductImages-Sleeve-Black-1_400x.jpg',
            variantId: '67890',
            tierId: 'tier1748560909690',
            tierName: 'Tier 2'
          }]
        };
        
        // Temporarily override the giftsByTier for testing
        const originalGiftsByTier = giftsByTier;
        giftsByTier = testGifts;
        
        console.log('GWP Debug: Test gifts set:', testGifts);
        
        // Call the update function
        updateProgressBarIcons();
        
        // Restore original gifts after 10 seconds
        setTimeout(() => {
          giftsByTier = originalGiftsByTier;
          console.log('GWP Debug: Restored original gifts');
        }, 12000);
      };
      
      // Test function to manually check icon mapping
      window.gwpDebugIconMapping = function() {
        console.log('GWP Debug: Debugging icon mapping...');
        
        const icons = document.querySelectorAll('.custom-progress-icon.complete');
        console.log('GWP Debug: Found icons:', icons.length);
        
        icons.forEach((icon, index) => {
          console.log(\`GWP Debug: Icon \${index}:\`, {
            id: icon.id,
            classes: icon.className,
            style: icon.getAttribute('style'),
            innerHTML: icon.innerHTML.substring(0, 100) + '...'
          });
          
          const spans = icon.querySelectorAll('span');
          spans.forEach((span, spanIndex) => {
            const spanText = span.textContent.trim();
            console.log(\`GWP Debug: Icon \${index} Span \${spanIndex}: "\${spanText}"\`);
            
            const dollarMatch = spanText.match(/\$(\d+(?:\.\d{2})?)/);
            if (dollarMatch) {
              const dollarAmount = parseFloat(dollarMatch[1]);
              const thresholdAmount = dollarAmount * 100;
              console.log(\`GWP Debug: Icon \${index} threshold: \${thresholdAmount} cents\`);
              
              // Check if this matches our tiers
              if (thresholdAmount === 8000) {
                console.log(\`GWP Debug: Icon \${index} matches $80 tier (Silver)\`);
              } else if (thresholdAmount === 7000) {
                console.log(\`GWP Debug: Icon \${index} matches legacy $70 tier (treating as Silver)\`);
              } else if (thresholdAmount === 12000) {
                console.log(\`GWP Debug: Icon \${index} matches $100 tier (Gold)\`);
              } else {
                console.log(\`GWP Debug: Icon \${index} does not match gift tiers\`);
              }
            }
          });
        });
        
        console.log('GWP Debug: Current gwpConfig:', gwpConfig);
        console.log('GWP Debug: Current giftsByTier:', giftsByTier);
      };
      
      // Test function to reset progress bar icons
      window.gwpResetProgressBarIcons = function() {
        console.log('GWP Debug: Resetting progress bar icons...');
        
        const progressIcons = document.querySelectorAll('.custom-progress-icon.complete');
        progressIcons.forEach((icon, index) => {
          resetProgressIcon(icon);
          console.log(\`GWP Debug: Reset icon \${index}\`);
        });
        
        console.log('GWP Debug: Progress bar icon reset completed');
      };
      
      // Simple test function to manually test progress bar icon updates
      window.gwpTestIconUpdate = function() {
        console.log('GWP Debug: Testing manual icon update...');
        
        // Find the progress icons
        const icons = document.querySelectorAll('.custom-progress-icon.complete');
        console.log('GWP Debug: Found', icons.length, 'progress icons');
        
        if (icons.length >= 2) {
          // Test updating the $80 icon (usually index 1)
          const icon80 = icons[1];
          const testImageUrl = 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-ProductImages-Sleeve-SweetCherry-1_400x.jpg';
          
          console.log('GWP Debug: Testing icon update on icon 1 ($80 tier)');
          updateProgressIcon(icon80, testImageUrl, 'Test Gift', 'Silver');
          
          // Test updating the $100 icon (usually index 2)
          if (icons.length >= 3) {
            const icon100 = icons[2];
            const testImageUrl2 = 'https://cdn.shopify.com/s/files/1/0110/7827/1033/files/Web-ProductImages-Sleeve-Black-1_400x.jpg';
            
            console.log('GWP Debug: Testing icon update on icon 2 ($100 tier)');
            updateProgressIcon(icon100, testImageUrl2, 'Test Gift 2', 'Gold');
          }
        } else {
          console.log('GWP Debug: Not enough progress icons found for testing');
        }
      };
      
      // Test function to manually check variant expansion
      window.gwpTestVariantExpansion = async function(collectionHandle = 'gwp-tier-1') {
        console.log('GWP Debug: === TESTING VARIANT EXPANSION ===');
        console.log('GWP Debug: Testing collection:', collectionHandle);
        
        try {
          const products = await fetchCollectionProducts(collectionHandle);
          console.log('GWP Debug: Expanded variants result:', products);
          
          console.log('GWP Debug: Variant breakdown:');
          products.forEach((variant, index) => {
            console.log(\`  \${index + 1}. \${variant.title}\`);
            console.log(\`     Variant ID: \${variant.variantId}\`);
            console.log(\`     Product ID: \${variant.productId}\`);
            console.log(\`     Product Title: \${variant.productTitle}\`);
            console.log(\`     Variant Title: \${variant.variantTitle}\`);
            console.log(\`     Image: \${variant.image ? variant.image.substring(0, 60) + '...' : 'No image'}\`);
            console.log(\`     Price: $\${(parseInt(variant.price) / 100).toFixed(2)}\`);
            console.log('');
          });
          
          console.log(\`GWP Debug: Total variants found: \${products.length}\`);
          console.log('GWP Debug: === END VARIANT EXPANSION TEST ===');
          
          return products;
        } catch (error) {
          console.error('GWP Debug: Error testing variant expansion:', error);
          return [];
        }
      };
      
      // Enhanced function to check what gifts are actually in the cart
      window.gwpCheckCartGifts = function() {
        console.log('GWP Debug: === CHECKING CART GIFTS ===');
        
        if (!cartData || !cartData.items) {
          console.log('GWP Debug: No cart data available');
          return;
        }
        
        console.log('GWP Debug: Total cart items:', cartData.items.length);
        
        cartData.items.forEach((item, index) => {
          console.log('GWP Debug: Cart item ' + index + ':', {
            title: item.title,
            variant_id: item.variant_id,
            price: item.price,
            final_price: item.final_price,
            properties: item.properties,
            featured_image: item.featured_image,
            image: item.image
          });
          
          // Check if this looks like a gift
          const isGift = item.price === 0 || 
                        item.final_price === 0 ||
                        (item.properties && (
                          item.properties._gwp_gift === 'true' ||
                          item.properties['_gwp_gift'] === 'true' ||
                          item.properties._gift_with_purchase === 'true' ||
                          item.properties['_gift_with_purchase'] === 'true'
                        ));
          
          if (isGift) {
            console.log('GWP Debug: *** GIFT ITEM FOUND ***', item.title);
            console.log('GWP Debug: Gift properties:', item.properties);
            console.log('GWP Debug: Gift image info:', {
              featured_image: item.featured_image,
              image: item.image,
              variant_image: item.variant_image
            });
          }
        });
        
        console.log('GWP Debug: === END CART GIFTS CHECK ===');
      };
      
      // Function to force update progress bar with actual cart data
      window.gwpForceProgressUpdate = function() {
        console.log('GWP Debug: Force updating progress bar with cart data...');
        
        // First refresh cart data
        fetchCartData().then(() => {
          console.log('GWP Debug: Cart data refreshed, now updating icons...');
          
          // Check what gifts we have
          window.gwpCheckCartGifts();
          
          // Try to update progress bar icons
          setTimeout(() => {
            updateProgressBarIcons();
          }, 500);
        });
      };
    })();
  `;

  return new Response(cartModalScript, {
    headers: {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300', // 5 minutes cache
    },
  });
}; 