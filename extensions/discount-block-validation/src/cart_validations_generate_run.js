// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// Backstop for "Block all discounts" (app/lib/discountBlock.server.js). The
// checkout extension removes codes customers enter, but it can't in Apple Pay /
// Google Pay express checkout, so this blocks checkout if any discount still
// applies. This can't tell codes from automatic discounts, so while the block
// is on the app's own discount functions apply nothing and every other
// automatic discount is paused.

export const DEFAULT_MESSAGE = "Discount codes can't be used with our current sale prices.";

// Only when the customer tries to pay. At CART_INTERACTION an error would
// reject cart updates (adding items) while a code sits in the cart. At
// CHECKOUT_INTERACTION it flashes a red error every time a code is entered,
// in the moment before the checkout extension removes it.
const CHECKOUT_STEPS = new Set(["CHECKOUT_COMPLETION"]);

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const config = /** @type {{ enabled?: boolean, message?: string } | null} */ (input.shop.block?.jsonValue ?? null);
  const step = input.buyerJourney?.step;
  if (!config?.enabled || !step || !CHECKOUT_STEPS.has(step)) {
    return { operations: [] };
  }

  const discounted = input.cart.discountApplications.some(
    (application) => Number(application.totalAllocatedAmount.amount) > 0
  );
  if (!discounted) return { operations: [] };

  const message = (typeof config.message === "string" && config.message.trim()) || DEFAULT_MESSAGE;
  return {
    operations: [
      {
        validationAdd: {
          errors: [{ message: `${message} Please remove the discount to continue.`, target: "$.cart" }],
        },
      },
    ],
  };
}
