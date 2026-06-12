/**
 * Discount by Line Item Property.
 *
 * Applies a discount to every cart line that carries a specific line item
 * property (matched by key). The key is merchant-configured and passed into
 * the input query via the `line_property_discount.variables` metafield, so the
 * `attribute(key: $propertyKey)` field resolves to that property on each line.
 *
 * A line "matches" when that attribute is present (non-null). We intentionally
 * do not inspect the value — the Functions API can only fetch a property by a
 * known key, and "key exists" is the configured match rule.
 *
 * Two modes are supported:
 *
 *   1) Flat (legacy):   { valueType, amount }
 *        Every matching line gets the same discount, regardless of count.
 *
 *   2) Tiered:          { tiers: [{ minCount, valueType, amount }, ...] }
 *        The function counts matching lines and applies the HIGHEST tier
 *        whose `minCount` is satisfied. If no tier matches (e.g. only 1
 *        matching line and the lowest tier requires 2), no discount is
 *        applied — letting the discount auto-adjust as items are added or
 *        removed from cart. This is what Make It a Set uses: the storefront
 *        stamps `_MS` on every set member, and Shopify re-evaluates this
 *        function on every cart change so the tier follows the live count.
 *
 * Tiered mode takes precedence when `tiers` is a non-empty array. Otherwise
 * the function falls back to the flat config for backward compatibility.
 */
export function run(input) {
  const configValue = input.discount?.metafield?.value;
  if (!configValue) {
    console.log("[LinePropertyDiscount] config: NULL");
    return { operations: [] };
  }

  let config;
  try {
    config = JSON.parse(configValue);
  } catch (e) {
    console.log("[LinePropertyDiscount] JSON parse error:", e.message);
    return { operations: [] };
  }

  // Require the PRODUCT discount class to be enabled.
  if (!input.discount.discountClasses.includes("PRODUCT")) {
    console.log("[LinePropertyDiscount] PRODUCT discount class not enabled — exiting");
    return { operations: [] };
  }

  // First pass: collect matching cart lines (those carrying the configured
  // attribute key — the input query scopes attribute() to that key, so
  // `attribute != null` means present).
  const lines = input.cart.lines ?? [];
  const matching = [];
  for (const line of lines) {
    if (!line.attribute) continue;
    matching.push(line);
  }

  if (!matching.length) {
    console.log("[LinePropertyDiscount] No lines carry the configured property — no discount");
    return { operations: [] };
  }

  // Resolve the discount value: tiered if configured, else flat.
  const value = resolveValue(config, matching.length);
  if (!value) {
    // Either invalid config or — in tiered mode — no tier matched the
    // current count. Returning [] explicitly drops any previously-applied
    // discount on the next cart re-evaluation.
    console.log(
      `[LinePropertyDiscount] No applicable discount for matching count = ${matching.length}`,
    );
    return { operations: [] };
  }

  const title = config.title || "Discount applied";
  const candidates = matching.map((line) => ({
    message: title,
    targets: [{ cartLine: { id: line.id } }],
    value,
  }));

  console.log(
    `[LinePropertyDiscount] Discounting ${candidates.length} line(s)`,
  );

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildValue(valueType, amount) {
  const numericAmount = parseFloat(amount);
  if (!valueType || !(numericAmount > 0)) return null;

  if (valueType === "percentage") {
    const pct = Math.min(Math.max(numericAmount, 0), 100);
    return { percentage: { value: pct } };
  }
  if (valueType === "fixedAmount") {
    return {
      fixedAmount: {
        appliesToEachItem: true,
        amount: numericAmount.toString(),
      },
    };
  }
  return null;
}

function resolveValue(config, matchingCount) {
  // Tiered mode — pick the highest tier whose minCount <= live matching count.
  if (Array.isArray(config.tiers) && config.tiers.length > 0) {
    let best = null;
    for (const tier of config.tiers) {
      const minCount = parseInt(tier.minCount, 10);
      if (!(minCount > 0) || matchingCount < minCount) continue;
      if (!best || minCount > parseInt(best.minCount, 10)) best = tier;
    }
    if (!best) return null;
    return buildValue(best.valueType, best.amount);
  }

  // Flat mode (legacy).
  return buildValue(config.valueType, config.amount);
}
