/**
 * Buy X, Buy Y, Get Z free.
 *
 * Collection-based slots use inAnyCollection input query variables
 * populated from a metafield at runtime.
 * Product-based slots are matched by product ID stored in the config.
 *
 * If a product matches multiple slots (e.g. both X and Z),
 * its quantity is consumed for the buy rule first — only leftover
 * units are eligible for the free gift.
 */
export function run(input) {
  const configValue = input.discount?.metafield?.value;
  if (!configValue) {
    console.log("[BuyXYGetZ] config: NULL");
    return { operations: [] };
  }

  let config;
  try {
    config = JSON.parse(configValue);
  } catch (e) {
    console.log("[BuyXYGetZ] JSON parse error:", e.message);
    return { operations: [] };
  }

  const { title, minQuantityX = 1, minQuantityY = 1, maxFreeQty = 1 } = config;
  const lines = input.cart.lines;

  function matchesSlot(line, slotType, slotId, slotFlag) {
    const product = line.merchandise?.product;
    if (!product) return false;
    if (slotType === 'product') return product.id === slotId;
    return product[slotFlag] === true;
  }

  const remaining = new Map();
  for (const line of lines) {
    remaining.set(line.id, line.quantity);
  }

  let xNeeded = minQuantityX;
  for (const line of lines) {
    if (xNeeded <= 0) break;
    if (!matchesSlot(line, config.xType, config.xId, 'isX')) continue;
    const consume = Math.min(remaining.get(line.id), xNeeded);
    remaining.set(line.id, remaining.get(line.id) - consume);
    xNeeded -= consume;
  }
  if (xNeeded > 0) return { operations: [] };

  let yNeeded = minQuantityY;
  for (const line of lines) {
    if (yNeeded <= 0) break;
    if (!matchesSlot(line, config.yType, config.yId, 'isY')) continue;
    const consume = Math.min(remaining.get(line.id), yNeeded);
    remaining.set(line.id, remaining.get(line.id) - consume);
    yNeeded -= consume;
  }
  if (yNeeded > 0) return { operations: [] };

  const zLines = lines
    .filter((line) => matchesSlot(line, config.zType, config.zId, 'isZ') && remaining.get(line.id) > 0)
    .sort((a, b) => {
      const priceA = parseFloat(a.cost?.amountPerQuantity?.amount ?? '0');
      const priceB = parseFloat(b.cost?.amountPerQuantity?.amount ?? '0');
      return priceA - priceB;
    });

  const candidates = [];
  let freeLeft = maxFreeQty;
  for (const line of zLines) {
    if (freeLeft <= 0) break;
    const avail = remaining.get(line.id);
    if (avail <= 0) continue;
    const qty = Math.min(avail, freeLeft);
    candidates.push({
      message: title || "Free gift!",
      targets: [{ cartLine: { id: line.id, quantity: qty } }],
      value: { percentage: { value: 100 } },
    });
    freeLeft -= qty;
  }

  if (!candidates.length) return { operations: [] };

  console.log("[BuyXYGetZ] Discounting", maxFreeQty - freeLeft, "Z item(s)");

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
