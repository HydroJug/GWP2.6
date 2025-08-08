import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from '../generated/api';


/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */

export function cartLinesDiscountsGenerateRun(input) {
  console.log("🎁 GWP FUNCTION RUNNING - Cart total: $", parseFloat(input.cart.cost.subtotalAmount.amount) / 100);
  
  const cart = input.cart;
  const subtotal = parseFloat(cart.cost.subtotalAmount.amount);

  // Get tier configuration from discount metafields
  let gwpConfig = {
    tiers: [
      {
        id: 'tier1',
        name: 'Silver',
        thresholdAmount: 8000, // Fallback values
        tag: 'tier1-gift',
        maxSelections: 1
      },
      {
        id: 'tier2', 
        name: 'Gold',
        thresholdAmount: 12000, // Fallback values
        tag: 'tier2-gift',
        maxSelections: 1
      }
    ]
  };

  // Try to get configuration from metafield
  if (input.discount?.metafield) {
    const tiersMetafield = input.discount.metafield;
    if (tiersMetafield && tiersMetafield.value) {
      try {
        const metafieldConfig = JSON.parse(tiersMetafield.value);
        if (metafieldConfig && Array.isArray(metafieldConfig)) {
          gwpConfig.tiers = metafieldConfig;
          console.log("🎁 Using tier configuration from metafield:", gwpConfig.tiers);
        }
      } catch (error) {
        console.error("🎁 Error parsing tiers metafield:", error);
      }
    }
  }
  
  // Sort tiers by threshold amount (lowest first)
  const sortedTiers = gwpConfig.tiers.sort((a, b) => a.thresholdAmount - b.thresholdAmount);

  const operations = [];
  const candidates = [];

  // Process each tier dynamically
  for (const tier of sortedTiers) {
    const tierThreshold = tier.thresholdAmount / 100; // Convert cents to dollars
    const tierName = tier.name;
    
    // Find products from this tier by tag
    const tierProducts = cart.lines.filter(line => {
      // Check if product has the specific tier tag
      if (tier.tag && line.merchandise.product.hasTags) {
        const tagResponse = line.merchandise.product.hasTags.find(tagResp => tagResp.tag === tier.tag);
        const hasTag = tagResponse && tagResponse.hasTag;
        return hasTag;
      }
      
      // Fallback: check specific product types for backward compatibility
      if (tierName === 'Silver' && line.merchandise.product.productType.includes('Traveler Sleeve')) {
        return true;
      }
      if (tierName === 'Gold' && line.merchandise.product.productType.includes('Can Cooler')) {
        return true;
      }
      
      return false;
    });

    // Sort products by price (lowest first)
    tierProducts.sort((a, b) => {
      const priceA = parseFloat(a.cost.subtotalAmount.amount) / a.quantity;
      const priceB = parseFloat(b.cost.subtotalAmount.amount) / b.quantity;
      return priceA - priceB;
    });

    console.log(`🎁 ${tierName} Tier: ${tierProducts.length} products found, threshold: $${tierThreshold}`);

    // Add candidate if threshold met and products available
    if (subtotal >= tierThreshold && tierProducts.length > 0) {
      // Calculate cost per item by dividing line total by quantity
      const tierLineCost = parseFloat(tierProducts[0].cost.subtotalAmount.amount);
      const tierQuantity = tierProducts[0].quantity;
      const tierProductCost = tierLineCost / tierQuantity;
      
      // Calculate remaining total after subtracting this gift
      let remainingTotal = subtotal - tierProductCost;
      
      // Subtract costs of already discounted gifts from lower tiers
      for (const lowerTier of sortedTiers) {
        if (lowerTier.thresholdAmount < tier.thresholdAmount) {
          const lowerTierProducts = cart.lines.filter(line => {
            if (lowerTier.tag && line.merchandise.product.hasTags) {
              const tagResponse = line.merchandise.product.hasTags.find(tagResp => tagResp.tag === lowerTier.tag);
              return tagResponse && tagResponse.hasTag;
            }
            return false;
          });
          
          if (lowerTierProducts.length > 0) {
            const lowerTierLineCost = parseFloat(lowerTierProducts[0].cost.subtotalAmount.amount);
            const lowerTierQuantity = lowerTierProducts[0].quantity;
            const lowerTierProductCost = lowerTierLineCost / lowerTierQuantity;
            remainingTotal -= lowerTierProductCost;
          }
        }
      }
      
      // Only apply discount if remaining total (excluding gifts) still meets threshold
      if (remainingTotal >= tierThreshold) {
        console.log(`✅ ${tierName} Tier: Adding discount candidate`);
        candidates.push({
          targets: [{
            cartLine: {
              id: tierProducts[0].id,
              quantity: 1
            }
          }],
          value: {
            percentage: {
              value: 100
            }
          },
          message: `Free ${tierName} Tier Gift!`
        });
      } else {
        console.log(`❌ ${tierName} Tier: Remaining total $${remainingTotal} below threshold $${tierThreshold}`);
      }
    } else {
      console.log(`❌ ${tierName} Tier: Threshold not met or no products available`);
    }
  }

  // Add single productDiscountsAdd operation with all candidates
  if (candidates.length > 0) {
    console.log(`🎉 GWP SUCCESS: Applying ${candidates.length} discount(s)`);
    
    operations.push({
      productDiscountsAdd: {
        candidates,
        selectionStrategy: "ALL",
      }
    });
  } else {
    console.log(`💤 GWP: No discounts applied`);
  }

  return {
    operations
  };
}