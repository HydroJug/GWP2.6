import {
  reactExtension,
  Banner,
  BlockStack,
  Button,
  Heading,
  Image,
  InlineLayout,
  Modal,
  Text,
  SkeletonText,
  useApi,
  useApplyCartLinesChange,
  useCartLines,
  useTranslate,
  useDiscountCodes,
  View,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';

// Extension target for checkout
export default reactExtension(
  'purchase.checkout.cart-line-list.render-after',
  () => <Extension />,
);

function Extension() {
  const translate = useTranslate();
  const { extension } = useApi();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const discountCodes = useDiscountCodes();
  
  const [showModal, setShowModal] = useState(false);
  const [availableTiers, setAvailableTiers] = useState([]);
  const [selectedGifts, setSelectedGifts] = useState({});
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(null);
  const [lastCartTotal, setLastCartTotal] = useState(0);
  const [hasShownModalForTier, setHasShownModalForTier] = useState(new Set());

  // Calculate cart total in cents
  const cartTotal = cartLines.reduce((total, line) => {
    return total + (line.cost.totalAmount.amount * 100);
  }, 0);

  // Check if there are GWP items in cart
  const hasGWPItems = cartLines.some(line => {
    // Check if this line item has GWP properties indicating it's a gift
    const attributes = line.attributes || [];
    return attributes.some(attr => 
      (attr.key === '_gwp_gift' && attr.value === 'true') ||
      (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
      (attr.key === '_gwp_tier_id' && attr.value) ||
      (attr.key === '_gift_tier_id' && attr.value)
    ) || line.cost.totalAmount.amount === 0; // Also check for $0 items
  });

  // Define allowed GWP discount codes
  const allowedGWPDiscountCodes = [
    'FREE SILVER TIER GIFT!',
    'FREE GOLD TIER GIFT!'
  ];

  // Check if discount codes are applied and filter out GWP codes
  const appliedDiscountCodes = discountCodes || [];
  const nonGWPDiscountCodes = appliedDiscountCodes.filter(discount => {
    const code = discount.code || discount;
    return !allowedGWPDiscountCodes.includes(code.toUpperCase());
  });

  const hasNonGWPDiscountCodes = nonGWPDiscountCodes.length > 0;
  const hasAnyDiscountCodes = appliedDiscountCodes.length > 0;
  const showDiscountWarning = hasGWPItems && hasAnyDiscountCodes;

  // Debug logging for discount codes and GWP items
  useEffect(() => {
    console.log('GWP Extension Debug:', {
      hasGWPItems,
      hasAnyDiscountCodes,
      hasNonGWPDiscountCodes,
      showDiscountWarning,
      discountCodes: discountCodes?.map(code => code.code || code) || [],
      nonGWPDiscountCodes: nonGWPDiscountCodes.map(code => code.code || code),
      cartLinesWithAttributes: cartLines.map(line => ({
        id: line.id,
        title: line.merchandise.title,
        attributes: line.attributes,
        price: line.cost.totalAmount.amount
      }))
    });
  }, [hasGWPItems, hasAnyDiscountCodes, hasNonGWPDiscountCodes, showDiscountWarning, discountCodes, nonGWPDiscountCodes, cartLines]);

  // Fetch tier configuration from our API
  useEffect(() => {
    const fetchTierConfig = async () => {
      try {
        setConfigLoading(true);
        setConfigError(null);
        
        // Try multiple methods to get the shop domain
        let shopDomain = null;
        
        // Method 1: extension.shop.myshopifyDomain
        if (extension?.shop?.myshopifyDomain) {
          shopDomain = extension.shop.myshopifyDomain;
          console.log('Shop domain detected via extension.shop.myshopifyDomain:', shopDomain);
        }
        
        // Method 2: extension.shop.domain
        if (!shopDomain && extension?.shop?.domain) {
          shopDomain = extension.shop.domain;
          console.log('Shop domain detected via extension.shop.domain:', shopDomain);
        }
        
        // Method 3: extension.target.shop.domain
        if (!shopDomain && extension?.target?.shop?.domain) {
          shopDomain = extension.target.shop.domain;
          console.log('Shop domain detected via extension.target.shop.domain:', shopDomain);
        }
        
        // Method 4: extension.environment.shop
        if (!shopDomain && extension?.environment?.shop) {
          shopDomain = extension.environment.shop;
          console.log('Shop domain detected via extension.environment.shop:', shopDomain);
        }
        
        // Log all available extension properties for debugging
        console.log('Full extension object:', extension);
        console.log('Extension.shop:', extension?.shop);
        console.log('Extension.target:', extension?.target);
        console.log('Extension.environment:', extension?.environment);
        
        // Fallback to main production site instead of development site
        const finalShopDomain = shopDomain || 'hydrojug.myshopify.com';
        
        console.log('Final shop domain to use:', finalShopDomain);
        
        // Fetch configuration from our public API endpoint
        const apiUrl = `https://gwp-2-5-hxluwv1gv-hydrojug.vercel.app/api/public/gwp-settings?shop=${encodeURIComponent(finalShopDomain)}`;
          
        console.log('Fetching GWP configuration from:', apiUrl);
        
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch configuration: ${response.status}`);
        }

        const data = await response.json();
        console.log('Received GWP configuration:', data);
        
        // Parse tiers from the response
        let tiers = [];
        if (data.tiers) {
          try {
            tiers = typeof data.tiers === 'string' ? JSON.parse(data.tiers) : data.tiers;
            
            // For collection-based tiers, we need to fetch products from the collections
            for (let tier of tiers) {
              if (tier.collectionHandle && (!tier.giftProducts || tier.giftProducts.length === 0)) {
                console.log(`Fetching products from collection: ${tier.collectionHandle}`);
                
                try {
                  // Fetch products from the collection using Shopify's public API
                  const collectionUrl = `https://${finalShopDomain}/collections/${tier.collectionHandle}/products.json?limit=10`;
                  const collectionResponse = await fetch(collectionUrl);
                  
                  if (collectionResponse.ok) {
                    const collectionData = await collectionResponse.json();
                    console.log(`Found ${collectionData.products?.length || 0} products in collection ${tier.collectionHandle}`);
                    
                    // Convert products to the format we need - expand all variants
                    const allProducts = collectionData.products?.slice(0, 10) || [];
                    const allVariants = [];
                    
                    allProducts.forEach(product => {
                      if (!product.variants || !Array.isArray(product.variants)) {
                        console.log(`Product has no variants: ${product.title}`);
                        return;
                      }
                      
                      // Filter available variants
                      const availableVariants = product.variants.filter(variant => {
                        const isAvailable = variant && variant.available;
                        console.log(`Variant ${variant.title} of ${product.title} available: ${isAvailable}`);
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
                          variantImage = product.images?.[0]?.src || product.featured_image || `https://via.placeholder.com/150x150/cccccc/666666?text=${encodeURIComponent(product.title)}`;
                        }
                        
                        // Create a display title that includes both product and variant info
                        let displayTitle = product.title;
                        if (variant.title && variant.title !== 'Default Title' && variant.title !== product.title) {
                          // If variant has a meaningful title, append it
                          displayTitle = `${product.title} - ${variant.title}`;
                        }
                        
                        allVariants.push({
                          variantId: variant.id.toString(),
                          productId: product.id.toString(),
                          title: displayTitle,
                          productTitle: product.title,
                          variantTitle: variant.title,
                          image: variantImage,
                          price: "0.00" // Will be set to $0 by cart transform
                        });
                        
                        console.log(`Added variant option: ${displayTitle} (${variant.id})`);
                      });
                    });
                    
                    // Limit to reasonable number of options (12 variants max)
                    const giftProducts = allVariants.slice(0, 12);
                    
                    console.log(`Filtered to ${giftProducts.length} available variants from ${allProducts.length} total products in collection ${tier.collectionHandle}`);
                    
                    // Update the tier with the fetched products
                    tier.giftProducts = giftProducts;
                    tier.giftVariantIds = giftProducts.map(p => p.variantId);
                    
                    console.log(`Updated tier ${tier.id} with ${giftProducts.length} products from collection`);
                    
                    // Log each product's image URL for debugging
                    giftProducts.forEach(product => {
                      console.log(`Product: ${product.title}, Image: ${product.image}`);
                    });
                  } else {
                    console.error(`Failed to fetch collection ${tier.collectionHandle}:`, collectionResponse.status);
                  }
                } catch (collectionError) {
                  console.error(`Error fetching collection ${tier.collectionHandle}:`, collectionError);
                }
              }
            }
          } catch (parseError) {
            console.error('Error parsing tiers configuration:', parseError);
            tiers = [];
          }
        }
        
        console.log('Parsed tiers:', tiers);
        setAvailableTiers(tiers);
        setConfigLoading(false);
        
      } catch (error) {
        console.error('Error fetching tier configuration:', error);
        setConfigError(error.message);
        setConfigLoading(false);
        
        // Fallback to basic working configuration
        const fallbackTiers = [
          {
            id: "tier-1",
            name: "Silver",
            thresholdAmount: 8000, // $80.00 in cents
            description: "Free gift with $80+ purchase",
            maxSelections: 1,
            giftVariantIds: ["44382780391481"],
            giftProducts: [
              {
                variantId: "44382780391481",
                productId: "7873478066233",
                title: "Black Can Cooler",
                image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/HJ_ProductShot_BlkCanCooler.png?v=1609872033",
                price: "0.00"
              }
            ]
          }
        ];
        setAvailableTiers(fallbackTiers);
      }
    };
    
    fetchTierConfig();
  }, [extension]);

  // Auto-show modal when new tiers are unlocked
  useEffect(() => {
    if (configLoading || availableTiers.length === 0) return;

    const unlockedTiers = getUnlockedTiers();
    const availableSelections = getAvailableSelections();
    
    // Check if we've unlocked a new tier that we haven't shown the modal for
    const newlyUnlockedTiers = unlockedTiers.filter(tier => 
      !hasShownModalForTier.has(tier.id) && 
      availableSelections[tier.id]?.remaining > 0
    );

    // Show modal automatically when cart total increases and new tiers are unlocked
    if (newlyUnlockedTiers.length > 0 && cartTotal > lastCartTotal && cartTotal > 0) {
      // Small delay to ensure cart has finished updating
      setTimeout(() => setShowModal(true), 500);
      
      // Mark these tiers as shown
      const newShownTiers = new Set(hasShownModalForTier);
      newlyUnlockedTiers.forEach(tier => newShownTiers.add(tier.id));
      setHasShownModalForTier(newShownTiers);
    }

    setLastCartTotal(cartTotal);
  }, [cartTotal, availableTiers, configLoading]);

  // Auto-remove gifts when cart total drops below tier thresholds
  useEffect(() => {
    if (configLoading || availableTiers.length === 0) return;

    const removeIneligibleGifts = async () => {
      const giftsToRemove = [];
      
      console.log('Checkout Extension: Checking for ineligible gifts to remove');
      console.log('Checkout Extension: Current cart total:', cartTotal, 'cents ($' + (cartTotal/100).toFixed(2) + ')');
      console.log('Checkout Extension: Existing gifts in cart:', existingGifts.length);
      
      // Check each gift in cart for eligibility
      for (const line of existingGifts) {
        const attributes = line.attributes || [];
        
        console.log('Checkout Extension: Checking gift:', line.merchandise.title, 'attributes:', attributes);
        
        // Find the tier ID for this gift
        const tierIdAttr = attributes.find(attr => 
          attr.key === '_gift_tier_id' || attr.key === '_gwp_tier_id'
        );
        
        if (tierIdAttr) {
          const giftTierId = tierIdAttr.value;
          
          console.log('Checkout Extension: Gift tier ID:', giftTierId);
          
          // Find the tier configuration
          const giftTier = availableTiers.find(tier => tier.id === giftTierId);
          
          if (giftTier) {
            console.log('Checkout Extension: Found matching tier:', giftTier.name, 'threshold:', giftTier.thresholdAmount);
            
            // Check if cart total is still above this tier's threshold
            const isStillEligible = cartTotal >= giftTier.thresholdAmount;
            
            console.log('Checkout Extension: Gift still eligible:', isStillEligible);
            
            if (!isStillEligible) {
              console.log(`Checkout Extension: Gift from tier ${giftTier.name} (${giftTierId}) is no longer eligible. Cart total: $${(cartTotal/100).toFixed(2)}, Required: $${(giftTier.thresholdAmount/100).toFixed(2)}`);
              giftsToRemove.push({
                lineId: line.id,
                tierName: giftTier.name,
                productTitle: line.merchandise.title,
                tierThreshold: giftTier.thresholdAmount
              });
            } else {
              // Special case: Check for tier downgrade (e.g., from Gold to Silver)
              // If they have a Gold tier gift but cart total is only eligible for Silver
              const sortedTiers = [...availableTiers].sort((a, b) => b.thresholdAmount - a.thresholdAmount);
              const currentEligibleTier = sortedTiers.find(tier => cartTotal >= tier.thresholdAmount);
              
              console.log('Checkout Extension: Checking tier downgrade - Current eligible tier:', currentEligibleTier ? currentEligibleTier.name : 'none');
              
              // If the gift is from a higher tier than what they're currently eligible for
              if (currentEligibleTier && giftTier.thresholdAmount > currentEligibleTier.thresholdAmount) {
                console.log(`Checkout Extension: Gift from tier ${giftTier.name} needs to be removed due to tier downgrade. Current eligible tier: ${currentEligibleTier.name}`);
                giftsToRemove.push({
                  lineId: line.id,
                  tierName: giftTier.name,
                  productTitle: line.merchandise.title,
                  tierThreshold: giftTier.thresholdAmount,
                  reason: 'tier_downgrade'
                });
              }
            }
          } else {
            console.log('Checkout Extension: Could not find tier configuration for ID:', giftTierId);
          }
        } else {
          console.log('Checkout Extension: Gift has no tier ID, checking if it should be removed due to low cart total');
          
          // If it's a gift but we can't identify the tier, and cart total is very low, remove it
          if (cartTotal < 8000) { // Below lowest Silver tier ($80)
            console.log('Checkout Extension: Removing unidentified gift due to low cart total');
            giftsToRemove.push({
              lineId: line.id,
              tierName: 'Unknown',
              productTitle: line.merchandise.title,
              tierThreshold: 8000,
              reason: 'unidentified_low_total'
            });
          }
        }
      }
      
      // Remove ineligible gifts
      if (giftsToRemove.length > 0) {
        console.log(`Checkout Extension: Removing ${giftsToRemove.length} ineligible gifts`);
        
        for (const gift of giftsToRemove) {
          try {
            const reason = gift.reason === 'tier_downgrade' 
              ? `due to tier downgrade (was ${gift.tierName}, now below $${(gift.tierThreshold/100).toFixed(2)} threshold)`
              : gift.reason === 'unidentified_low_total'
              ? 'because it is an unidentified gift and cart total is below minimum threshold'
              : `because cart total ($${(cartTotal/100).toFixed(2)}) is below ${gift.tierName} threshold ($${(gift.tierThreshold/100).toFixed(2)})`;
              
            console.log(`Checkout Extension: Removing ineligible gift: ${gift.productTitle} from ${gift.tierName} tier ${reason}`);
            
            const result = await applyCartLinesChange({
              type: 'removeCartLine',
              id: gift.lineId,
            });
            
            if (result.type === 'success') {
              console.log(`Checkout Extension: Successfully removed ${gift.productTitle} from cart`);
              
              // Clear from selected gifts state to allow re-selection later
              const giftKey = Object.keys(selectedGifts).find(key => 
                key.includes(gift.tierName.toLowerCase()) || 
                key.includes(gift.productTitle.toLowerCase())
              );
              if (giftKey) {
                setSelectedGifts(prev => {
                  const updated = { ...prev };
                  delete updated[giftKey];
                  return updated;
                });
              }
            } else {
              console.error(`Checkout Extension: Failed to remove ${gift.productTitle}:`, result);
            }
          } catch (error) {
            console.error(`Checkout Extension: Error removing gift ${gift.productTitle}:`, error);
          }
        }
      } else {
        console.log('Checkout Extension: No ineligible gifts found to remove');
      }
    };

    // Run removal check if cart total has decreased OR if there are gifts in cart (more aggressive checking)
    if ((cartTotal < lastCartTotal && existingGifts.length > 0) || (existingGifts.length > 0 && cartTotal < 8000)) {
      console.log('Checkout Extension: Running gift removal check - Cart total decreased or gifts present with low total');
      // Small delay to ensure cart has finished updating
      setTimeout(removeIneligibleGifts, 300);
    }
  }, [cartTotal, lastCartTotal, existingGifts, availableTiers, configLoading, applyCartLinesChange, selectedGifts]);

  // Get existing gift items in cart
  const existingGifts = cartLines.filter(line => 
    line.attributes.some(attr => 
      // Check for checkout extension gifts
      (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
      // Check for cart modal gifts
      (attr.key === '_gwp_gift' && attr.value === 'true')
    )
  );

  // Check which tiers are unlocked
  const getUnlockedTiers = () => {
    return availableTiers.filter(tier => cartTotal >= tier.thresholdAmount);
  };

  // Get available selections for each tier
  const getAvailableSelections = () => {
    const unlockedTiers = getUnlockedTiers();
    const availableSelections = {};
    
    // Sort tiers by threshold amount (highest first) to prioritize higher tiers
    const sortedTiers = [...unlockedTiers].sort((a, b) => b.thresholdAmount - a.thresholdAmount);
    
    sortedTiers.forEach(tier => {
      const tierGifts = existingGifts.filter(gift => 
        gift.attributes.some(attr => 
          // Check for checkout extension tier ID
          (attr.key === '_gift_tier_id' && attr.value === tier.id) ||
          // Check for cart modal tier ID
          (attr.key === '_gwp_tier_id' && attr.value === tier.id)
        )
      );
      const remainingSelections = tier.maxSelections - tierGifts.length;
      
      if (remainingSelections > 0) {
        // Check if there are any higher tier gifts already in cart
        const hasHigherTierGifts = sortedTiers.some(higherTier => {
          if (higherTier.thresholdAmount <= tier.thresholdAmount) return false;
          
          const higherTierGiftsInCart = existingGifts.filter(gift => 
            gift.attributes.some(attr => 
              (attr.key === '_gift_tier_id' && attr.value === higherTier.id) ||
              (attr.key === '_gwp_tier_id' && attr.value === higherTier.id)
            )
          );
          
          return higherTierGiftsInCart.length > 0;
        });
        
        if (!hasHigherTierGifts) {
          availableSelections[tier.id] = {
            tier,
            remaining: remainingSelections,
            selected: tierGifts.length
          };
        }
      }
    });
    
    return availableSelections;
  };

  // Get next tier threshold for progress indication
  const getNextTierThreshold = () => {
    const nextTier = availableTiers.find(tier => cartTotal < tier.thresholdAmount);
    return nextTier ? nextTier.thresholdAmount : null;
  };

  // Get highest unlocked tier
  const getHighestTier = () => {
    const unlockedTiers = getUnlockedTiers();
    return unlockedTiers.length > 0 ? unlockedTiers[unlockedTiers.length - 1] : null;
  };

  // Handle gift selection
  const handleSelectGift = async (variantId, tierId, productInfo) => {
    try {
      console.log('Attempting to add gift with variant ID:', variantId, 'Product info:', productInfo);

      const result = await applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
        quantity: 1,
        attributes: [
          {
            key: '_gift_with_purchase',
            value: 'true'
          },
          {
            key: '_gift_tier_id', 
            value: tierId
          },
          // Add cart modal compatible properties for cross-platform recognition
          {
            key: '_gwp_gift',
            value: 'true'
          },
          {
            key: '_gwp_tier_id',
            value: tierId
          },
          {
            key: '_gwp_added_via',
            value: 'checkout_extension'
          }
        ]
      });

      console.log('Add to cart result:', result);

      if (result.type === 'success') {
        setSelectedGifts(prev => ({
          ...prev,
          [`${tierId}-${variantId}`]: true
        }));
        
        // Auto-close modal if all available selections are made
        const availableSelections = getAvailableSelections();
        const totalRemaining = Object.values(availableSelections).reduce((sum, sel) => sum + sel.remaining, 0);
        
        if (totalRemaining <= 1) { // Will be 0 after this selection
          setTimeout(() => setShowModal(false), 1000); // Small delay to show success
        }
      } else {
        console.error('Failed to add gift to cart:', result);
        
        // Show user-friendly error message
        if (result.message && result.message.includes('merchandise variant referenced by this term condition could not be found')) {
          console.error('Product variant not found - this usually means the variant ID is incorrect or the product is not available');
          // You could show a toast notification here if available
          alert('Sorry, this gift is currently unavailable. Please try another option or contact support.');
        } else {
          console.error('Unknown error adding gift to cart:', result.message);
          alert('Sorry, there was an error adding this gift to your cart. Please try again.');
        }
      }
    } catch (error) {
      console.error('Failed to add gift to cart:', error);
      alert('Sorry, there was an error adding this gift to your cart. Please try again.');
    }
  };

  // Handle modal button click with debugging
  const handleModalButtonClick = () => {
    console.log('Modal button clicked, current showModal state:', showModal);
    setShowModal(true);
    console.log('Modal state set to true');
  };

  // Check if we should show the gift offer
  const availableSelections = getAvailableSelections();
  const showGiftOffer = Object.keys(availableSelections).length > 0 && !hasNonGWPDiscountCodes;
  const highestTier = getHighestTier();
  const nextTier = getNextTierThreshold();

  // Show loading state while fetching configuration
  if (configLoading) {
    return (
      <BlockStack spacing="base">
        <Banner status="info">
          <BlockStack spacing="tight">
            <SkeletonText inlineSize="large" />
            <SkeletonText inlineSize="medium" />
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // Show error state if configuration failed to load
  if (configError) {
    return (
      <BlockStack spacing="base">
        <Banner status="critical">
          <Text size="small">
            Unable to load gift configuration. Please refresh the page or contact support.
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  // Show gift offer banner if eligible
  if (showGiftOffer) {
    return (
      <BlockStack spacing="base">
        {/* Discount code warning banner */}
        {showDiscountWarning && (
          <Banner status="warning">
            <Text size="small" emphasis="strong">
              ⚠️ *Free gifts cannot be combined with other discount codes or promotional offers
            </Text>
          </Banner>
        )}
        
        <Banner status="success">
          <BlockStack spacing="tight">
            <Text size="medium" emphasis="strong">
              🎁 {highestTier ? `${highestTier.name}: ${highestTier.description}` : "Free gifts available!"}
            </Text>
            <Text size="small">
              {highestTier && `${highestTier.name}: ${highestTier.description}`}
            </Text>
            <Button
              kind="secondary"
              onPress={handleModalButtonClick}
            >
              {highestTier ? "Choose Your Free Gift" : "Select Free Gift"}{Object.keys(availableSelections).length > 1 ? 's' : ''}
            </Button>
          </BlockStack>
        </Banner>

        {/* Next tier progress */}
        {nextTier && (
          <Banner status="info">
            <Text size="small">
              {`$${((nextTier - cartTotal) / 100).toFixed(2)} away from next tier`}
            </Text>
          </Banner>
        )}

        {/* Gift Selection Modal - Try inline display instead of modal */}
        {showModal && (
          <BlockStack spacing="none" padding="extraTight" border="base" cornerRadius="base">
            <BlockStack spacing="extraTight">
              <Heading level={3} size="small">Choose Your Free Gift{Object.keys(availableSelections).length > 1 ? 's' : ''}</Heading>
              <Text size="extraSmall" appearance="subdued">
                Select your complimentary gifts to add to your cart:
              </Text>
              
              {Object.entries(availableSelections).map(([tierId, selection]) => (
                <BlockStack key={tierId} spacing="none" padding={['extraTight', 'none', 'none', 'none']}>
                  <Text size="extraSmall" emphasis="strong">{selection.tier.name}</Text>
                  <Text size="extraSmall" appearance="subdued">
                    {selection.tier.description} - {selection.remaining} remaining
                  </Text>
                  
                  <BlockStack spacing="none" padding={['extraTight', 'none', 'none', 'none']}>
                    {(selection.tier.giftProducts || []).map(product => {
                      console.log('Rendering product:', product.title, 'Image URL:', product.image);
                      
                      // Ensure image URL is valid and properly formatted
                      let imageUrl = product.image;
                      
                      // Handle relative URLs by making them absolute
                      if (imageUrl && !imageUrl.startsWith('http')) {
                        if (imageUrl.startsWith('//')) {
                          imageUrl = 'https:' + imageUrl;
                        } else if (imageUrl.startsWith('/')) {
                          imageUrl = 'https://cdn.shopify.com' + imageUrl;
                        }
                      }
                      
                      // Fallback to placeholder if no valid image
                      if (!imageUrl || !imageUrl.startsWith('http')) {
                        imageUrl = `https://via.placeholder.com/60x60/cccccc/666666?text=${encodeURIComponent(product.title || 'Gift')}`;
                      }
                      
                      console.log('Final image URL:', imageUrl);
                      
                      return (
                        <BlockStack key={product.variantId} spacing="extraTight" padding="extraTight">
                          <InlineLayout spacing="tight" blockAlignment="center">
                            <View>
                              <Image
                                source={imageUrl}
                                accessibilityDescription={`${product.title} - Gift product`}
                                aspectRatio={1}
                                fit="cover"
                                loading="eager"
                                sizes="small"
                              />
                            </View>
                            <BlockStack spacing="none">
                              <Text size="extraSmall" emphasis="strong">
                                {product.title || `Gift Product ${product.variantId}`}
                              </Text>
                              <Text size="extraSmall" appearance="subdued">
                                Free with your purchase
                              </Text>
                            </BlockStack>
                            <Button
                              kind="secondary"
                              size="extraSmall"
                              disabled={selectedGifts[`${tierId}-${product.variantId}`]}
                              onPress={() => handleSelectGift(product.variantId, tierId, product)}
                            >
                              {selectedGifts[`${tierId}-${product.variantId}`] ? 'Added' : 'Add'}
                            </Button>
                          </InlineLayout>
                        </BlockStack>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              ))}
              
              <Button
                kind="secondary"
                size="small"
                onPress={() => setShowModal(false)}
              >
                Close
              </Button>
            </BlockStack>
          </BlockStack>
        )}
      </BlockStack>
    );
  }

  // Show progress toward first tier (only if no non-GWP discount codes are applied)
  if (availableTiers.length > 0 && cartTotal > 0 && !hasNonGWPDiscountCodes) {
    const firstTier = availableTiers[0];
    const progress = (cartTotal / firstTier.thresholdAmount) * 100;
    const remaining = firstTier.thresholdAmount - cartTotal;
    
    if (remaining > 0) {
      return (
        <BlockStack spacing="base">
          {/* Discount code warning banner for progress section */}
          {showDiscountWarning && (
            <Banner status="warning">
              <Text size="small" emphasis="strong">
                ⚠️ *Free gifts cannot be combined with other discount codes or promotional offers
              </Text>
            </Banner>
          )}
          
          <Banner status="info">
            <BlockStack spacing="tight">
              <Text size="medium" emphasis="strong">
                🎁 {`You're $${(remaining / 100).toFixed(2)} away from a free gift!`}
              </Text>
              <Text size="small">
                {firstTier.description}
              </Text>
            </BlockStack>
          </Banner>
        </BlockStack>
      );
    }
  }

  // Show special banner when non-GWP discount codes are blocking gift offers
  if (hasNonGWPDiscountCodes && (Object.keys(availableSelections).length > 0 || (availableTiers.length > 0 && cartTotal >= availableTiers[0].thresholdAmount))) {
    return (
      <BlockStack spacing="base">
        <Banner status="warning">
          <BlockStack spacing="tight">
            <Text size="medium" emphasis="strong">
              🚫 Free gifts unavailable with current discount code
            </Text>
            <Text size="small">
              Free gifts cannot be combined with other discount codes. Remove your current discount code to access free gifts, or keep your discount for savings.
            </Text>
            <Text size="extraSmall" appearance="subdued">
              Allowed codes: FREE SILVER TIER GIFT!, FREE GOLD TIER GIFT!
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // Show standalone discount warning if we have discount codes but no other banners
  if (showDiscountWarning && !showGiftOffer && !(availableTiers.length > 0 && cartTotal > 0)) {
    return (
      <BlockStack spacing="base">
        <Banner status="warning">
          <Text size="small" emphasis="strong">
            ⚠️ *Free gifts cannot be combined with other discount codes or promotional offers
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  return null;
}