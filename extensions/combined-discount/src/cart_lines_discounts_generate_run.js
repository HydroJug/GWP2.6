/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const metafieldValue = input.discount?.metafield?.value;
  if (!metafieldValue) return { operations: [] };

  let config;
  try {
    config = JSON.parse(metafieldValue);
  } catch {
    return { operations: [] };
  }

  const { discountValueType, discountValue, minimumOrderAmount } = config;

  if (!discountValue || parseFloat(discountValue) <= 0) {
    return { operations: [] };
  }

  // Enforce minimum order subtotal
  if (minimumOrderAmount && parseFloat(minimumOrderAmount) > 0) {
    const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);
    if (subtotal < parseFloat(minimumOrderAmount)) {
      return { operations: [] };
    }
  }

  const parsedValue = parseFloat(discountValue);

  const value =
    discountValueType === 'percentage'
      ? { percentage: { value: parsedValue } }
      : { fixedAmount: { amount: parsedValue.toFixed(2), appliesOnEachItem: false } };

  const message =
    discountValueType === 'percentage'
      ? `${parsedValue}% off your order`
      : `$${parsedValue.toFixed(2)} off your order`;

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message,
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value,
            },
          ],
          selectionStrategy: 'FIRST',
        },
      },
    ],
  };
}
