/**
 * @typedef {import("../generated/api").DeliveryInput} RunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  const firstDeliveryGroup = input.cart.deliveryGroups[0];
  if (!firstDeliveryGroup) return { operations: [] };

  const deliveryOptions = firstDeliveryGroup.deliveryOptions;
  if (!deliveryOptions?.length) return { operations: [] };

  const metafieldValue = input.discount?.metafield?.value;
  if (!metafieldValue) return { operations: [] };

  let config;
  try {
    config = JSON.parse(metafieldValue);
  } catch {
    return { operations: [] };
  }

  // Only apply free shipping if the config enables it
  if (!config.includesFreeShipping) return { operations: [] };

  // Enforce minimum order subtotal for free shipping
  const freeShippingMin = config.freeShippingMinimum || config.minimumOrderAmount;
  if (freeShippingMin && parseFloat(freeShippingMin) > 0) {
    const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);
    if (subtotal < parseFloat(freeShippingMin)) {
      return { operations: [] };
    }
  }

  // Filter by maxShippingCost if set — only make rates at or below that amount free
  const maxCost = config.maxShippingCost ? parseFloat(config.maxShippingCost) : null;
  const eligibleOptions = maxCost !== null
    ? deliveryOptions.filter(option => parseFloat(option.cost.amount) <= maxCost)
    : deliveryOptions;

  if (!eligibleOptions.length) return { operations: [] };

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: eligibleOptions.map(option => ({
            message: 'Free Shipping',
            targets: [{ deliveryOption: { handle: option.handle } }],
            value: { percentage: { value: 100 } },
          })),
          selectionStrategy: 'ALL',
        },
      },
    ],
  };
}
