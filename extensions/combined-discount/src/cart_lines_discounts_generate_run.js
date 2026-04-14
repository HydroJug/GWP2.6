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

  const {
    discountValueType,
    discountValue,
    minimumOrderAmount,
    discountScope,
    appliesTo,
    productIds,
    customerEligibility,
    customerIds,
  } = config;

  if (!discountValue || parseFloat(discountValue) <= 0) {
    return { operations: [] };
  }

  // ── Customer eligibility ──────────────────────────────────────────────────
  if ((customerEligibility === 'specific_customers' || customerEligibility === 'specific_segments') && customerIds?.length) {
    const customerId = input.cart.buyerIdentity?.customer?.id;
    if (!customerId || !customerIds.includes(customerId)) {
      return { operations: [] };
    }
  }

  // ── Minimum order subtotal ────────────────────────────────────────────────
  if (minimumOrderAmount && parseFloat(minimumOrderAmount) > 0) {
    const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);
    if (subtotal < parseFloat(minimumOrderAmount)) {
      return { operations: [] };
    }
  }

  const parsedValue = parseFloat(discountValue);

  // ── Product-level discount ────────────────────────────────────────────────
  if (discountScope === 'product') {
    const lines = input.cart.lines ?? [];
    let qualifyingLines;

    if (appliesTo === 'products' && productIds?.length) {
      qualifyingLines = lines.filter((line) => {
        const productId = line.merchandise?.product?.id;
        return productId && productIds.includes(productId);
      });
    } else if (appliesTo === 'collections') {
      qualifyingLines = lines.filter(
        (line) => line.merchandise?.product?.inAnyCollection === true
      );
    } else {
      qualifyingLines = lines;
    }

    if (!qualifyingLines.length) return { operations: [] };

    const candidates = qualifyingLines.map((line) => ({
      message:
        discountValueType === 'percentage'
          ? `${parsedValue}% off`
          : `$${parsedValue.toFixed(2)} off`,
      targets: [{ cartLine: { id: line.id } }],
      value:
        discountValueType === 'percentage'
          ? { percentage: { value: parsedValue } }
          : {
              fixedAmount: {
                amount: parsedValue.toFixed(2),
                appliesToEachItem: true,
              },
            },
    }));

    return {
      operations: [
        {
          productDiscountsAdd: {
            candidates,
            selectionStrategy: 'ALL',
          },
        },
      ],
    };
  }

  // ── Order-level discount (default) ────────────────────────────────────────
  const value =
    discountValueType === 'percentage'
      ? { percentage: { value: parsedValue } }
      : { fixedAmount: { amount: parsedValue.toFixed(2), appliesToEachItem: false } };

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
