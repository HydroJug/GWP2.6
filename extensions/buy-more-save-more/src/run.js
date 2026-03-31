/**
 * Buy More, Save More
 *
 * Applies tiered quantity-based discounts. The merchant configures a
 * list of eligible product IDs and price-break tiers. The function
 * counts how many eligible products are in the cart and applies the
 * best qualifying tier to those line items.
 *
 * Config shape:
 *   {
 *     productIds: ["gid://shopify/Product/123", ...],
 *     tiers: [
 *       { minQty: 1, discountValue: "0",  discountType: "percentage" },
 *       { minQty: 3, discountValue: "5",  discountType: "percentage" },
 *       { minQty: 6, discountValue: "10", discountType: "percentage" },
 *     ]
 *   }
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

  const productIds = config.productIds ?? [];
  const tiers = config.tiers ?? [];

  if (!productIds.length || !tiers.length) return { operations: [] };

  const eligibleIdSet = new Set(productIds);

  // Tally eligible quantity and collect matching lines
  let totalQty = 0;
  const targetLines = [];
  for (const line of input.cart.lines) {
    const productId = line.merchandise?.product?.id ?? null;
    if (productId && eligibleIdSet.has(productId)) {
      totalQty += line.quantity;
      targetLines.push(line);
    }
  }

  if (!targetLines.length) return { operations: [] };

  // Find best tier: highest minQty that totalQty satisfies
  const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
  const bestTier = sorted.find((t) => totalQty >= t.minQty) ?? null;

  if (!bestTier || parseFloat(bestTier.discountValue) <= 0) {
    return { operations: [] };
  }

  const parsedValue = parseFloat(bestTier.discountValue);

  const value =
    bestTier.discountType === "percentage"
      ? { percentage: { value: parsedValue } }
      : { fixedAmount: { amount: parsedValue.toFixed(2), appliesOnEachItem: true } };

  const message =
    bestTier.discountType === "percentage"
      ? `Buy more, save ${parsedValue}%`
      : `Buy more, save $${parsedValue.toFixed(2)} per item`;

  const candidates = targetLines.map((line) => ({
    message,
    targets: [{ cartLine: { id: line.id, quantity: line.quantity } }],
    value,
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
