// No imports needed - using string literals for selectionStrategy


/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */

export function cartLinesDiscountsGenerateRun(input) {
  // MoneyV2.amount is a decimal string in dollars (e.g., "95.95" = $95.95)
  // Convert to cents for comparison with thresholdAmount (which is in cents)
  const subtotalInDollars = parseFloat(input.cart.cost.subtotalAmount.amount);
  const subtotal = Math.round(subtotalInDollars * 100); // Convert to cents
  console.log("🎁 GWP FUNCTION RUNNING - Cart total: $", subtotalInDollars.toFixed(2), `(${subtotal} cents)`);
  
  const cart = input.cart;
  
  // Log all cart lines for debugging
  console.log("📦 Cart lines in order:");
  cart.lines.forEach((line, index) => {
    const productTitle = line.merchandise?.product?.title || 'Unknown';
    const productId = line.merchandise?.product?.id || 'Unknown';
    console.log(`  Line ${index}: CartLine ID=${line.id}, Product="${productTitle}" (${productId}), Qty=${line.quantity}`);
  });

  // Get tier configuration from discount metafields
  let gwpConfig = {
    tiers: [
      {
        id: 'tier1', 
        name: 'Default',
        thresholdAmount: 7000, // Fallback values
        productIds: [], // Product IDs from collection
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
          gwpConfig.tiers = metafieldConfig.map((tier, index) => {
            if (!tier.id) {
              tier.id = `tier_${index}_${tier.thresholdAmount}`;
              console.log(`⚠️ Tier at index ${index} missing ID, generated: ${tier.id}`);
            }
            if (!tier.name) {
              tier.name = `Tier ${index + 1}`;
            }
            // Ensure productIds is an array
            if (!Array.isArray(tier.productIds)) {
              tier.productIds = [];
            }
            return tier;
          });
          console.log("🎁 Using tier configuration from metafield:");
          gwpConfig.tiers.forEach((tier, index) => {
            console.log(`  Tier ${index + 1}: ID="${tier.id}", Name="${tier.name}", Threshold=$${(tier.thresholdAmount / 100).toFixed(2)}, Products: ${tier.productIds.length}`);
            if (tier.productIds.length > 0) {
              console.log(`    First 3 product IDs: ${tier.productIds.slice(0, 3).join(', ')}${tier.productIds.length > 3 ? '...' : ''}`);
            }
          });
        }
      } catch (error) {
        console.error("🎁 Error parsing tiers metafield:", error);
      }
    }
  }
  
  // Sort tiers by threshold amount (lowest first) so lower tiers are processed first
  const sortedTiers = gwpConfig.tiers.sort((a, b) => a.thresholdAmount - b.thresholdAmount);
  
  // Verify tier IDs are unique
  const tierIds = sortedTiers.map(t => t.id);
  const uniqueTierIds = new Set(tierIds);
  if (tierIds.length !== uniqueTierIds.size) {
    console.error(`❌ CRITICAL: Duplicate tier IDs found! This will cause incorrect behavior.`);
    console.error(`   Tier IDs:`, tierIds);
  }

  const operations = [];
  const candidates = [];

  // Process each tier - now matching by PRODUCT ID instead of tags
  for (const tier of sortedTiers) {
    const tierThreshold = tier.thresholdAmount; // In cents
    const tierName = tier.name || tier.id;
    
    console.log(`\n🔍 Processing ${tierName} Tier (ID: ${tier.id}, Threshold: $${(tierThreshold / 100).toFixed(2)}, Products: ${tier.productIds.length})`);
    
    // Find products from this tier by matching product ID against the tier's productIds list
    const tierProducts = cart.lines.filter(line => {
      const productId = line.merchandise?.product?.id;
      if (!productId) return false;
      
      // Check if this product's ID is in the tier's productIds list
      const isMatch = tier.productIds.includes(productId);
      
      if (isMatch) {
          const productTitle = line.merchandise?.product?.title || 'Unknown';
        console.log(`  ✓ ${tierName} Tier: Product "${productTitle}" (${productId}) matches tier collection`);
      }
      
      return isMatch;
    });

    // Sort products by price (lowest first) - cheapest gets discounted
    tierProducts.sort((a, b) => {
      const priceA = parseFloat(a.cost.subtotalAmount.amount) / a.quantity;
      const priceB = parseFloat(b.cost.subtotalAmount.amount) / b.quantity;
      return priceA - priceB;
    });

    console.log(`🎁 ${tierName} Tier: ${tierProducts.length} matching products found in cart, threshold: $${(tierThreshold / 100).toFixed(2)}`);

    // Check if threshold is met and products are available
    const subtotalDollars = subtotal / 100;
    const thresholdDollars = tierThreshold / 100;
    
    if (subtotalDollars >= thresholdDollars && tierProducts.length > 0) {
      // Calculate cost per item
      const tierLineCost = parseFloat(tierProducts[0].cost.subtotalAmount.amount);
      const tierQuantity = tierProducts[0].quantity;
      const tierProductCost = tierLineCost / tierQuantity;
      
      // Calculate remaining total after subtracting this gift
      let remainingTotal = subtotalDollars - tierProductCost;
      
      // Subtract costs of already discounted gifts from lower tiers
      for (const lowerTier of sortedTiers) {
        if (lowerTier.thresholdAmount < tier.thresholdAmount) {
          // Find products for this lower tier
          const lowerTierLines = cart.lines.filter(line => {
            const productId = line.merchandise?.product?.id;
            return productId && lowerTier.productIds.includes(productId);
          });
          
          const lowerThresholdDollars = lowerTier.thresholdAmount / 100;
          if (subtotalDollars >= lowerThresholdDollars && lowerTierLines.length > 0) {
            lowerTierLines.sort((a, b) => {
              const priceA = parseFloat(a.cost.subtotalAmount.amount) / a.quantity;
              const priceB = parseFloat(b.cost.subtotalAmount.amount) / b.quantity;
              return priceA - priceB;
            });
            
            const lowerTierLineCost = parseFloat(lowerTierLines[0].cost.subtotalAmount.amount);
            const lowerTierQuantity = lowerTierLines[0].quantity;
            const lowerTierProductCost = lowerTierLineCost / lowerTierQuantity;
            remainingTotal -= lowerTierProductCost;
          }
        }
      }
      
      // Only apply discount if remaining total still meets threshold
      if (remainingTotal >= thresholdDollars) {
        const selectedCartLineId = tierProducts[0].id;
        const productTitle = tierProducts[0].merchandise?.product?.title || 'Unknown';
        const discountMessage = `Free ${tier.name}!`;
        
        console.log(`✅ ${tierName} Tier: Adding discount candidate`);
        console.log(`   CartLine ID: ${selectedCartLineId}`);
        console.log(`   Product: "${productTitle}"`);
        console.log(`   Cart Line Quantity: ${tierProducts[0].quantity}`);
        console.log(`   Discount Quantity: 1`);
        console.log(`   Message: "${discountMessage}"`);
        
        candidates.push({
          targets: [{
            cartLine: {
              id: selectedCartLineId,
              quantity: 1
            }
          }],
          value: {
            percentage: {
              value: 100
            }
          },
          message: discountMessage
        });
      } else {
        console.log(`❌ ${tierName} Tier: Remaining total $${remainingTotal.toFixed(2)} below threshold $${thresholdDollars.toFixed(2)}`);
      }
    } else {
      console.log(`❌ ${tierName} Tier: Threshold not met (cart: $${subtotalDollars.toFixed(2)}, threshold: $${thresholdDollars.toFixed(2)}) or no matching products in cart`);
    }
  }

  // Add productDiscountsAdd operation with all candidates
  if (candidates.length > 0) {
    console.log(`🎉 GWP SUCCESS: Applying ${candidates.length} discount(s) - one per tier`);
    candidates.forEach((candidate, index) => {
      const cartLineId = candidate.targets[0]?.cartLine?.id;
      const matchingLine = cart.lines.find(line => line.id === cartLineId);
      const productTitle = matchingLine?.merchandise?.product?.title || 'Unknown';
      console.log(`  Candidate ${index + 1}: CartLine ${cartLineId}, Product "${productTitle}", Message: "${candidate.message}"`);
    });
    
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