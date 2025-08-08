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
import { useState, useEffect, useCallback } from 'react';

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

  // Load GWP configuration on component mount
  useEffect(() => {
    const loadConfiguration = async () => {
      try {
        setConfigLoading(true);
        setConfigError(null);
        
        // Get the shop domain from the current context
        const shop = extension.target.shop?.domain;
        if (!shop) {
          console.error('No shop domain available');
          setConfigError('Unable to determine shop domain');
          setConfigLoading(false);
          return;
        }
        
        console.log('Loading GWP configuration for shop:', shop);
        
        // Fetch configuration from the public API
        const response = await fetch(`https://gwp-2-6.vercel.app/app/gwp/public/gwp-settings?shop=${shop}`);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch configuration: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('GWP configuration response:', data);
        
        if (!data.is_active) {
          console.log('GWP is not active for this shop');
          setAvailableTiers([]);
          setConfigLoading(false);
          return;
        }
        
        const tiers = data.tiers || [];
        console.log('Parsed GWP tiers:', tiers);
        
        setAvailableTiers(tiers);
        setConfigLoading(false);
      } catch (error) {
        console.error('Error loading GWP configuration:', error);
        setConfigError(error.message);
        setConfigLoading(false);
      }
    };
    
    loadConfiguration();
  }, [extension.target.shop?.domain]);

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

  // Check if discount codes are applied
  const appliedDiscountCodes = discountCodes || [];
  const hasAnyDiscountCodes = appliedDiscountCodes.length > 0;
  const showDiscountWarning = hasGWPItems && hasAnyDiscountCodes;

  // Check which tiers are unlocked
  const getUnlockedTiers = () => {
    // Sort tiers by threshold (highest to lowest) to ensure proper validation
    const sortedTiers = [...availableTiers].sort((a, b) => b.thresholdAmount - a.thresholdAmount);
    
    const unlocked = sortedTiers.filter(tier => {
      // Double check tier thresholds
      let threshold = tier.thresholdAmount;
      if (tier.name === 'Gold' || tier.name.toLowerCase().includes('gold')) {
        threshold = 12000; // Enforce $120
      } else if (tier.name === 'Silver' || tier.name.toLowerCase().includes('silver')) {
        threshold = 8000; // Enforce $80
      }
      
      return cartTotal >= threshold;
    });
    
    return unlocked;
  };

  // Get available selections for each tier
  const getAvailableSelections = () => {
    const unlockedTiers = getUnlockedTiers();
    const availableSelections = {};
    
    // Sort tiers by threshold amount (highest first) to prioritize higher tiers
    const sortedTiers = [...unlockedTiers].sort((a, b) => b.thresholdAmount - a.thresholdAmount);
    
    sortedTiers.forEach(tier => {
      // Double check tier thresholds
      let threshold = tier.thresholdAmount;
      if (tier.name === 'Gold' || tier.name.toLowerCase().includes('gold')) {
        threshold = 12000; // Enforce $120
      } else if (tier.name === 'Silver' || tier.name.toLowerCase().includes('silver')) {
        threshold = 8000; // Enforce $80
      }
      
      // Skip if cart total is below threshold
      if (cartTotal < threshold) {
        return;
      }
      
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
          if (higherTier.thresholdAmount <= tier.thresholdAmount) {
            return false;
          }
          
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
            tier: {
              ...tier,
              thresholdAmount: threshold // Use enforced threshold
            },
            remaining: remainingSelections,
            selected: tierGifts.length
          };
        }
      }
    });
    
    return availableSelections;
  };

  // Get existing gift items in cart
  const existingGifts = cartLines.filter(line => 
    line.attributes.some(attr => 
      // Check for checkout extension gifts
      (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
      // Check for cart modal gifts
      (attr.key === '_gwp_gift' && attr.value === 'true')
    )
  );

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

  // Remove ineligible gifts that are no longer eligible based on cart total
  const removeIneligibleGifts = useCallback(async () => {
    try {
      if (!cartLines || !availableTiers || availableTiers.length === 0) {
        return;
      }
      
      // Find all gift items in cart
      const giftItems = cartLines.filter(line => {
        const attributes = line.attributes || [];
        return attributes.some(attr => 
          (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
          (attr.key === '_gwp_gift' && attr.value === 'true')
        );
      });
      
      const itemsToRemove = [];
      
      // Check each gift item against tier thresholds
      giftItems.forEach(giftItem => {
        const attributes = giftItem.attributes || [];
        
        // Find tier ID for this gift
        const tierIdAttr = attributes.find(attr => 
          attr.key === '_gift_tier_id' || attr.key === '_gwp_tier_id'
        );
        
        if (!tierIdAttr) {
          // If no tier ID, assume it's from the lowest tier
          const lowestTier = availableTiers.reduce((lowest, tier) => 
            tier.thresholdAmount < lowest.thresholdAmount ? tier : lowest
          );
          
          if (cartTotal < lowestTier.thresholdAmount) {
            itemsToRemove.push({
              item: giftItem,
              reason: 'Below lowest tier threshold',
              threshold: lowestTier.thresholdAmount
            });
          }
          return;
        }
        
        // Find matching tier configuration
        const tierId = tierIdAttr.value;
        const matchingTier = availableTiers.find(tier => tier.id === tierId);
        
        if (!matchingTier) {
          itemsToRemove.push({
            item: giftItem,
            reason: 'Tier configuration not found',
            threshold: null
          });
          return;
        }
        
        // Check if cart total is below this tier's threshold
        if (cartTotal < matchingTier.thresholdAmount) {
          itemsToRemove.push({
            item: giftItem,
            reason: 'Below tier threshold',
            tierName: matchingTier.name,
            threshold: matchingTier.thresholdAmount
          });
        }
      });
      
      // Remove ineligible items
      if (itemsToRemove.length > 0) {
        for (const itemToRemove of itemsToRemove) {
          try {
            const result = await applyCartLinesChange({
              type: 'removeCartLine',
              id: itemToRemove.item.id,
              quantity: itemToRemove.item.quantity
            });
            
            if (result.type === 'success') {
              // Update selected gifts state to remove this item
              setSelectedGifts(prev => {
                const updated = { ...prev };
                // Remove any selection that matches this item
                Object.keys(updated).forEach(key => {
                  if (key.includes(itemToRemove.item.merchandise?.id)) {
                    delete updated[key];
                  }
                });
                return updated;
              });
            }
          } catch (error) {
            console.error('Error removing gift:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Error in removeIneligibleGifts:', error);
    }
  }, [cartLines, cartTotal, availableTiers, applyCartLinesChange, setSelectedGifts]);

  // Auto-remove ineligible gifts when cart total changes
  useEffect(() => {
    if (cartTotal !== undefined && availableTiers.length > 0) {
      // Small delay to allow cart to stabilize after changes
      const timeoutId = setTimeout(() => {
        removeIneligibleGifts();
      }, 500);
      
      return () => clearTimeout(timeoutId);
    }
  }, [cartTotal, removeIneligibleGifts]);

  // Handle gift selection
  const handleSelectGift = async (variantId, tierId, productInfo) => {
    try {
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
          alert('Sorry, this gift is currently unavailable. Please try another option or contact support.');
        } else {
          alert('Sorry, there was an error adding this gift to your cart. Please try again.');
        }
      }
    } catch (error) {
      console.error('Failed to add gift to cart:', error);
      alert('Sorry, there was an error adding this gift to your cart. Please try again.');
    }
  };

  // Handle modal button click
  const handleModalButtonClick = () => {
    setShowModal(true);
  };

  // Check if we should show the gift offer
  const availableSelections = getAvailableSelections();
  const showGiftOffer = Object.keys(availableSelections).length > 0 && !hasAnyDiscountCodes;
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

  // Show progress toward first tier (only if no discount codes are applied)
  if (availableTiers.length > 0 && cartTotal > 0 && !hasAnyDiscountCodes) {
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

  // Show special banner when discount codes are blocking gift offers
  if (hasAnyDiscountCodes && (Object.keys(availableSelections).length > 0 || (availableTiers.length > 0 && cartTotal >= availableTiers[0].thresholdAmount))) {
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