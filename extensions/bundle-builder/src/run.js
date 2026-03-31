/**
 * Bundle Builder – product-level discount function.
 *
 * Collection-based items are identified via inAnyCollection input query
 * variables (s0 … s6) populated from a metafield at runtime.
 * Product-based items are matched by product ID stored in the config.
 *
 * minQty defines the ratio. A bundle of A(2):B(1):C(1) means for every
 * 2 of A, the customer needs 1 of B and 1 of C.
 *
 * Complete bundles = min( floor(slotQty / slotMinQty) ) across all slots.
 * Discounted items per slot = completeBundles * slotMinQty.
 *
 * All qualifying bundles are applied simultaneously.
 */

const SLOT_KEY = ['s0','s1','s2','s3','s4','s5','s6'];

export function run(input) {
  const metafieldValue = input.discount?.metafield?.value;
  if (!metafieldValue) {
    console.log("[BundleBuilder] config metafield: NULL");
    return { operations: [] };
  }

  let config;
  try {
    config = JSON.parse(metafieldValue);
  } catch (e) {
    console.log("[BundleBuilder] JSON parse error:", e.message);
    return { operations: [] };
  }

  const { bundles } = config;
  if (!bundles?.length) {
    console.log("[BundleBuilder] no bundles in config");
    return { operations: [] };
  }

  const lines = input.cart.lines;
  console.log("[BundleBuilder]", bundles.length, "tier(s),", lines.length, "cart line(s)");

  const qualifying = [];

  for (const bundle of bundles) {
    if (!bundle.items?.length) continue;

    const slotData = [];
    let valid = true;

    for (const item of bundle.items) {
      const minQty = item.minQty ?? 1;
      const matchingLines = [];
      let totalQty = 0;

      if (item.type === 'product' && item.productId) {
        for (const line of lines) {
          if (line.merchandise?.product?.id === item.productId) {
            matchingLines.push({ id: line.id, quantity: line.quantity });
            totalQty += line.quantity;
          }
        }
        console.log("[BundleBuilder] product", item.productId, "ratio", minQty, "has", totalQty);
      } else {
        const slotIdx = item.slot;
        if (slotIdx == null || slotIdx < 0 || slotIdx > 6) { valid = false; break; }
        const key = SLOT_KEY[slotIdx];
        for (const line of lines) {
          if (line.merchandise?.product?.[key]) {
            matchingLines.push({ id: line.id, quantity: line.quantity });
            totalQty += line.quantity;
          }
        }
        console.log("[BundleBuilder] slot", slotIdx, "ratio", minQty, "has", totalQty);
      }

      const possibleBundles = Math.floor(totalQty / minQty);
      if (possibleBundles < 1) { valid = false; break; }

      slotData.push({ minQty, matchingLines, possibleBundles });
    }

    if (!valid || !slotData.length) continue;

    let numBundles = Math.min(...slotData.map((s) => s.possibleBundles));
    const maxBundles = bundle.maxBundles ? parseInt(bundle.maxBundles) : 0;
    if (maxBundles > 0) numBundles = Math.min(numBundles, maxBundles);
    if (numBundles < 1) continue;

    const lineAllocations = new Map();
    for (const slot of slotData) {
      let remaining = numBundles * slot.minQty;
      for (const ml of slot.matchingLines) {
        if (remaining <= 0) break;
        const take = Math.min(ml.quantity, remaining);
        lineAllocations.set(ml.id, (lineAllocations.get(ml.id) || 0) + take);
        remaining -= take;
      }
    }

    qualifying.push({ bundle, numBundles, lineAllocations });
  }

  if (!qualifying.length) {
    console.log("[BundleBuilder] no qualifying bundles");
    return { operations: [] };
  }

  // Per line, keep only the highest discount value and max allocated qty
  const lineBest = new Map();
  for (const q of qualifying) {
    const parsedValue = parseFloat(q.bundle.discountValue);
    if (!parsedValue || parsedValue <= 0) continue;

    console.log("[BundleBuilder] Bundle", q.bundle.label || '(unnamed)', ":", q.bundle.discountType, parsedValue, "→", q.numBundles, "complete bundle(s)");

    for (const [lineId, qty] of q.lineAllocations) {
      if (qty <= 0) continue;
      const existing = lineBest.get(lineId);
      if (!existing || parsedValue > existing.discountValue) {
        lineBest.set(lineId, {
          qty: Math.max(qty, existing?.qty ?? 0),
          discountValue: parsedValue,
          discountType: q.bundle.discountType,
          message: q.bundle.label || 'Bundle discount',
        });
      } else if (parsedValue === existing.discountValue && qty > existing.qty) {
        existing.qty = qty;
      }
    }
  }

  const candidates = [];
  for (const [lineId, best] of lineBest) {
    const value = best.discountType === 'percentage'
      ? { percentage: { value: best.discountValue } }
      : { fixedAmount: { amount: best.discountValue.toFixed(2) } };
    candidates.push({
      message: best.message,
      targets: [{ cartLine: { id: lineId, quantity: best.qty } }],
      value,
    });
  }

  if (!candidates.length) return { operations: [] };

  console.log("[BundleBuilder] Applying to", candidates.length, "line(s)");

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
