// @ts-check

// Must match the surcharges in the etch-surcharge cart transform
const DEFAULT_SURCHARGE = 9.99;
const CUSTOM_UPLOAD_SURCHARGE = 12.99;

/**
 * Parse Ruby-style hash strings into JSON objects.
 * e.g. {"designType"=>"custom-upload"} → {"designType":"custom-upload"}
 */
function parseRubyHash(str) {
  try {
    return JSON.parse(str.replace(/=>/g, ':'));
  } catch {
    return null;
  }
}

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  // Read config from the discount's metafield
  const configValue = input.discount?.metafield?.value;
  if (!configValue) {
    console.log('[FreeEtch] No config metafield — exiting');
    return { operations: [] };
  }

  let config;
  try {
    config = JSON.parse(configValue);
  } catch {
    console.log('[FreeEtch] Config JSON parse error — exiting');
    return { operations: [] };
  }

  // orderMinimum is stored in cents
  const orderMinimumCents = config.orderMinimum ?? 0;

  // Require PRODUCT discount class
  if (!input.discount.discountClasses.includes("PRODUCT")) {
    console.log('[FreeEtch] Product discount class not enabled — exiting');
    return { operations: [] };
  }

  const lines = input.cart.lines;
  if (!lines.length) {
    console.log('[FreeEtch] Empty cart — exiting');
    return { operations: [] };
  }

  // Check order minimum against the base merchandise subtotal only.
  // Cart transforms run before discount functions, so cost.amountPerQuantity
  // on etched lines already includes the surcharge. Subtract it back out so
  // the etch fee itself never counts toward the minimum.
  let baseSubtotalCents = 0;
  for (const line of lines) {
    const pricePerUnit = parseFloat(line.cost.amountPerQuantity.amount) * 100;
    const etchValue = line.attribute?.value?.trim();
    if (etchValue) {
      const etchInfo = parseRubyHash(etchValue);
      const isCustomUpload = etchInfo?.designType === 'custom-upload';
      const surcharge = isCustomUpload ? CUSTOM_UPLOAD_SURCHARGE : DEFAULT_SURCHARGE;
      baseSubtotalCents += (pricePerUnit - surcharge * 100) * line.quantity;
    } else {
      baseSubtotalCents += pricePerUnit * line.quantity;
    }
  }
  console.log(`[FreeEtch] Base subtotal: ${baseSubtotalCents} cents, minimum: ${orderMinimumCents} cents`);

  if (baseSubtotalCents < orderMinimumCents) {
    console.log('[FreeEtch] Base subtotal below minimum — no discount');
    return { operations: [] };
  }

  // Identify lines with an etchInfo attribute
  const qualifyingLines = [];

  for (const line of lines) {
    const etchValue = line.attribute?.value?.trim();
    if (!etchValue) continue;

    const etchInfo = parseRubyHash(etchValue);
    const isCustomUpload = etchInfo?.designType === 'custom-upload';

    qualifyingLines.push({
      lineId: line.id,
      discountAmount: isCustomUpload ? CUSTOM_UPLOAD_SURCHARGE : DEFAULT_SURCHARGE,
      message: isCustomUpload ? 'Free Custom Etch' : 'Free Etch',
    });

    console.log(`[FreeEtch] Line ${line.id} qualifies — ${isCustomUpload ? 'custom-upload' : 'standard'} etch`);
  }

  if (!qualifyingLines.length) {
    console.log('[FreeEtch] No lines with etchInfo — no discount');
    return { operations: [] };
  }

  const candidates = qualifyingLines.map(({ lineId, discountAmount, message }) => ({
    message,
    targets: [{ cartLine: { id: lineId } }],
    value: {
      fixedAmount: {
        appliesToEachItem: true,
        amount: discountAmount.toString(),
      },
    },
  }));

  console.log(`[FreeEtch] Applying discount to ${candidates.length} line(s)`);

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
