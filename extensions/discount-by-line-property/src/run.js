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
 * The discount value is merchant-configurable: either a percentage off or a
 * fixed amount off each matching item.
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

  const { title, valueType, amount } = config;
  const numericAmount = parseFloat(amount);

  if (!valueType || !(numericAmount > 0)) {
    console.log("[LinePropertyDiscount] Invalid value config — exiting");
    return { operations: [] };
  }

  // Build the discount value once — it's the same for every matching line.
  let value;
  if (valueType === "percentage") {
    // Clamp to a sane 0–100 range.
    const pct = Math.min(Math.max(numericAmount, 0), 100);
    value = { percentage: { value: pct } };
  } else if (valueType === "fixedAmount") {
    value = {
      fixedAmount: {
        appliesToEachItem: true,
        amount: numericAmount.toString(),
      },
    };
  } else {
    console.log("[LinePropertyDiscount] Unknown valueType:", valueType);
    return { operations: [] };
  }

  const lines = input.cart.lines ?? [];
  const candidates = [];

  for (const line of lines) {
    // The query already scoped attribute() to the configured key, so any
    // non-null attribute here means the line carries that property.
    if (!line.attribute) continue;
    candidates.push({
      message: title || "Discount applied",
      targets: [{ cartLine: { id: line.id } }],
      value,
    });
  }

  if (!candidates.length) {
    console.log("[LinePropertyDiscount] No lines carry the configured property — no discount");
    return { operations: [] };
  }

  console.log(`[LinePropertyDiscount] Discounting ${candidates.length} line(s)`);

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
