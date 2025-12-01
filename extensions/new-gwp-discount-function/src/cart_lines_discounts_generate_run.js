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
    const tags = line.merchandise?.product?.hasTags || [];
    const activeTags = tags.filter(t => t.hasTag).map(t => t.tag).join(', ');
    console.log(`  Line ${index}: CartLine ID=${line.id}, Product="${productTitle}" (${productId}), Qty=${line.quantity}, Tags=[${activeTags || 'none'}]`);
  });

  // Get tier configuration from discount metafields
  let gwpConfig = {
    tiers: [
      // {
      //   id: 'tier1',
      //   name: 'Silver',
      //   thresholdAmount: 8000, // Fallback values
      //   tag: 'tier1-gift',
      //   maxSelections: 1
      // },
      {
        id: 'tier2', 
        name: 'Gold',
        thresholdAmount: 7000, // Fallback values
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
          // CRITICAL: Ensure each tier has a unique ID
          // If a tier doesn't have an ID, generate one based on its index
          gwpConfig.tiers = metafieldConfig.map((tier, index) => {
            if (!tier.id) {
              tier.id = `tier_${index}_${tier.thresholdAmount}`;
              console.log(`⚠️ Tier at index ${index} missing ID, generated: ${tier.id}`);
            }
            // Ensure required fields exist
            if (!tier.name) {
              tier.name = `Tier ${index + 1}`;
            }
            if (typeof tier.thresholdAmount !== 'number') {
              console.error(`❌ Tier ${tier.id} has invalid thresholdAmount:`, tier.thresholdAmount);
            }
            return tier;
          });
          console.log("🎁 Using tier configuration from metafield:");
          gwpConfig.tiers.forEach((tier, index) => {
            console.log(`  Tier ${index + 1}: ID="${tier.id}", Name="${tier.name}", Threshold=$${(tier.thresholdAmount / 100).toFixed(2)}, Tag="${tier.tag || 'N/A'}"`);
          });
        }
      } catch (error) {
        console.error("🎁 Error parsing tiers metafield:", error);
      }
    }
  }
  
  // Sort tiers by threshold amount (lowest first) so lower tiers are processed first
  // CRITICAL: This ensures we process tiers in the correct order
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

  // Process each tier dynamically - matching the working version's approach
  // IMPORTANT: Process tiers in order (lowest threshold first) to ensure proper selection
  for (const tier of sortedTiers) {
    // Keep threshold in cents for comparison (subtotal is in cents)
    const tierThreshold = tier.thresholdAmount; // Already in cents
    const tierName = tier.name || tier.id; // Fallback to tier.id if name is missing
    
    console.log(`\n🔍 Processing ${tierName} Tier (ID: ${tier.id}, Threshold: $${(tierThreshold / 100).toFixed(2)}, Tag: "${tier.tag || 'N/A'}")`);
    
    // Find products from this tier by product tag
    // IMPORTANT: Match the working version - don't filter out already-selected products here
    // We'll handle that by checking remaining total and only adding one candidate per tier
    const tierProducts = cart.lines.filter(line => {
      
      // Check if product has the specific tier tag (must match exactly)
      // Match the working version's simple approach - just check if it has the tag
      if (tier.tag && line.merchandise?.product?.hasTags) {
        const tagResponse = line.merchandise.product.hasTags.find(tagResp => tagResp.tag === tier.tag);
        const hasTag = tagResponse && tagResponse.hasTag;
        if (hasTag) {
          const productTitle = line.merchandise?.product?.title || 'Unknown';
          console.log(`  ✓ ${tierName} Tier: Product "${productTitle}" matches tag "${tier.tag}"`);
          return true;
        }
      }
      
      // Fallback: check specific product types for backward compatibility (only if no tag match)
      if (!tier.tag) {
        if (tierName === 'Silver' && line.merchandise?.product?.productType?.includes('Traveler Sleeve')) {
          const productTitle = line.merchandise?.product?.title || 'Unknown';
          console.log(`  ✓ ${tierName} Tier: Product "${productTitle}" matches product type fallback`);
          return true;
        }
        if (tierName === 'Gold' && line.merchandise?.product?.productType?.includes('Can Cooler')) {
          const productTitle = line.merchandise?.product?.title || 'Unknown';
          console.log(`  ✓ ${tierName} Tier: Product "${productTitle}" matches product type fallback`);
          return true;
        }
      }
      
      return false;
    });

    // Sort products by price (lowest first) - matching the working version exactly
    tierProducts.sort((a, b) => {
      const priceA = parseFloat(a.cost.subtotalAmount.amount) / a.quantity;
      const priceB = parseFloat(b.cost.subtotalAmount.amount) / b.quantity;
      return priceA - priceB;
    });

    console.log(`🎁 ${tierName} Tier: ${tierProducts.length} products found, threshold: $${(tierThreshold / 100).toFixed(2)} (${tierThreshold} cents), tag: "${tier.tag || 'N/A'}"`);

    // Add candidate if threshold met and products available - matching the working version's logic
    // Convert subtotal to dollars for comparison (working version uses dollars)
    const subtotalInDollars = subtotal / 100;
    const tierThresholdInDollars = tierThreshold / 100;
    
    if (subtotalInDollars >= tierThresholdInDollars && tierProducts.length > 0) {
      // Calculate cost per item by dividing line total by quantity - matching working version
      const tierLineCost = parseFloat(tierProducts[0].cost.subtotalAmount.amount);
      const tierQuantity = tierProducts[0].quantity;
      const tierProductCost = tierLineCost / tierQuantity;
      
      // Calculate remaining total after subtracting this gift
      let remainingTotal = subtotalInDollars - tierProductCost;
      
      // Subtract costs of already discounted gifts from lower tiers
      // Match the working version's approach - check if lower tier threshold was met
      for (const lowerTier of sortedTiers) {
        if (lowerTier.thresholdAmount < tier.thresholdAmount) {
          // Find products for this lower tier
          const lowerTierLines = cart.lines.filter(line => {
            if (lowerTier.tag && line.merchandise?.product?.hasTags) {
              const tagResponse = line.merchandise.product.hasTags.find(tagResp => tagResp.tag === lowerTier.tag);
              return tagResponse && tagResponse.hasTag;
            }
            return false;
          });
          
          // Check if lower tier threshold was met (matching working version's logic)
          const lowerTierThresholdInDollars = lowerTier.thresholdAmount / 100;
          if (subtotalInDollars >= lowerTierThresholdInDollars && lowerTierLines.length > 0) {
            // Sort and get cheapest
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
      
      // Only apply discount if remaining total (excluding gifts) still meets threshold
      // Match the working version - compare in dollars
      if (remainingTotal >= tierThresholdInDollars) {
        const selectedCartLineId = tierProducts[0].id;
        const productTitle = tierProducts[0].merchandise?.product?.title || 'Unknown';
        
        // CRITICAL: Build the discount message using the tier name from the configuration
        const discountMessage = `Free ${tier.name} Tier Gift!`;
        
        console.log(`✅ ${tierName} Tier: Adding discount candidate`);
        console.log(`   CartLine ID: ${selectedCartLineId}`);
        console.log(`   Product: "${productTitle}"`);
        console.log(`   Cart Line Quantity: ${tierProducts[0].quantity}`);
        console.log(`   Discount Quantity: 1`);
        console.log(`   Message: "${discountMessage}"`);
        
        // Create candidate with EXPLICIT quantity of 1 - exactly matching the working version
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
        console.log(`❌ ${tierName} Tier: Remaining total $${remainingTotal.toFixed(2)} below threshold $${tierThresholdInDollars.toFixed(2)}`);
      }
    } else {
      console.log(`❌ ${tierName} Tier: Threshold not met (cart: $${subtotalInDollars.toFixed(2)}, threshold: $${tierThresholdInDollars.toFixed(2)}) or no products available`);
    }
  }

  // Add single productDiscountsAdd operation with all candidates
  // Using ALL strategy applies discounts to all eligible tiers (one per tier)
  // Matching the working version's simple approach
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
        selectionStrategy: "ALL", // Apply all candidates (one per tier)
      }
    });
  } else {
    console.log(`💤 GWP: No discounts applied`);
  }

  return {
    operations
  };
}