// @ts-check

/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 */

/**
 * @type {FunctionRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const operations = [];

  console.log('Cart transform running, processing', input.cart.lines.length, 'lines');

  // Process each cart line to check for gift products
  input.cart.lines.forEach((line, index) => {
    console.log(`Processing line ${index}:`, {
      id: line.id,
      quantity: line.quantity,
      attribute: line.attribute
    });

    // Check if this line item has the gift attribute
    const giftAttribute = line.attribute;
    const isGift = giftAttribute && giftAttribute.key === '_gift_with_purchase' && giftAttribute.value === 'true';

    console.log(`Line ${index} is gift:`, isGift);

    if (isGift) {
      console.log(`Setting line ${index} to free (${line.id})`);
      
      // Create an operation to set the price to zero for gift items
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: "0.00"
              }
            }
          }
        }
      });
    }
  });

  console.log('Cart transform operations:', operations.length);

  // Return operations if any gifts were found, otherwise no changes
  return operations.length > 0 ? { operations } : NO_CHANGES;
};