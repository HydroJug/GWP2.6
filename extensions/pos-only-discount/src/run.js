/**
 * POS Only Discount
 *
 * Applies a percentage or fixed-amount discount only when the cart
 * has a specific attribute indicating a Point of Sale transaction.
 * The attribute key and value are configurable (default: channel=pos).
 *
 * Supports order-level or product-level discounts, optionally filtered
 * by specific products or collections.
 */
export function run(input) {
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
    channelKey = "channel",
    channelValue = "pos",
    discountScope = "order",
    appliesTo = "all",
    productIds,
  } = config;

  if (!discountValue || parseFloat(discountValue) <= 0) {
    return { operations: [] };
  }

  // Check the cart attribute to confirm this is a POS transaction.
  // The graphql query always fetches attribute(key: "channel"); if the
  // merchant has configured a different key, the check is skipped at the
  // graphql layer but we can still gate on value match.
  const attrValue = input.cart.attribute?.value ?? null;
  if (attrValue !== channelValue) {
    return { operations: [] };
  }

  // Enforce optional minimum order subtotal
  if (minimumOrderAmount && parseFloat(minimumOrderAmount) > 0) {
    const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);
    if (subtotal < parseFloat(minimumOrderAmount)) {
      return { operations: [] };
    }
  }

  const parsedValue = parseFloat(discountValue);

  // ── Product-level discount ────────────────────────────────────────────────
  if (discountScope === "product") {
    const lines = input.cart.lines ?? [];
    let qualifyingLines;

    if (appliesTo === "products" && productIds?.length) {
      qualifyingLines = lines.filter((line) => {
        const productId = line.merchandise?.product?.id;
        return productId && productIds.includes(productId);
      });
    } else if (appliesTo === "collections") {
      qualifyingLines = lines.filter(
        (line) => line.merchandise?.product?.inAnyCollection === true
      );
    } else {
      qualifyingLines = lines;
    }

    if (!qualifyingLines.length) return { operations: [] };

    const candidates = qualifyingLines.map((line) => ({
      message:
        discountValueType === "percentage"
          ? `${parsedValue}% off (POS)`
          : `$${parsedValue.toFixed(2)} off (POS)`,
      targets: [{ cartLine: { id: line.id } }],
      value:
        discountValueType === "percentage"
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
            selectionStrategy: "ALL",
          },
        },
      ],
    };
  }

  // ── Order-level discount (default) ────────────────────────────────────────
  const value =
    discountValueType === "percentage"
      ? { percentage: { value: parsedValue } }
      : { fixedAmount: { amount: parsedValue.toFixed(2), appliesOnEachItem: false } };

  const message =
    discountValueType === "percentage"
      ? `${parsedValue}% off (POS)`
      : `$${parsedValue.toFixed(2)} off (POS)`;

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
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
