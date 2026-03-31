import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

const DISCOUNT_DESCRIPTION = "Tapcart App Exclusive Discount";

const DEFAULT_CONFIG = {
  discountMethod: "amount_off_products",
  productDiscountAmount: 0,
  productDiscountPercentage: 10,
  buyQuantity: 1,
  getQuantity: 1,
  buyXGetYDiscountType: "free",
  buyXGetYValue: 0,
  orderDiscountAmount: 0,
  orderDiscountPercentage: 0,
  minimumOrderAmount: 0,
  freeShippingMinimumAmount: 50,
  startDate: "",
  endDate: "",
  channelKey: "channel",
  channelValue: "tapcart",
  eligibilityType: "all_customers",
  customerSegments: [],
  specificCustomers: [],
  minimumSpent: 0,
  customerTags: [],
};

function isCustomerEligible(customer, buyerIdentity, config) {
  const customerData = customer || buyerIdentity?.customer;

  if (!customerData) {
    return config.eligibilityType === "all_customers";
  }

  switch (config.eligibilityType) {
    case "all_customers":
      return true;
    case "specific_segments":
      if (config.customerSegments.length > 0) {
        const customerTags = customerData.tags || [];
        return config.customerSegments.some(segment => customerTags.includes(segment));
      }
      return false;
    case "specific_customers":
      if (config.specificCustomers.length > 0) {
        return config.specificCustomers.some(
          specificCustomer =>
            customerData.email === specificCustomer ||
            customerData.id === specificCustomer
        );
      }
      return false;
    default:
      return true;
  }
}

function checkAdditionalEligibility(customer, buyerIdentity, config) {
  const customerData = customer || buyerIdentity?.customer;

  if (!customerData) {
    return true;
  }

  if (config.minimumSpent > 0) {
    const amountSpent = parseFloat(customerData.amountSpent?.amount || "0");
    if (amountSpent < config.minimumSpent) {
      return false;
    }
  }

  if (config.customerTags.length > 0) {
    const customerTags = customerData.tags || [];
    const hasRequiredTags = config.customerTags.some(tag => customerTags.includes(tag));
    if (!hasRequiredTags) {
      return false;
    }
  }

  return true;
}

/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */
export function cartLinesDiscountsGenerateRun(input) {
  const { cart } = input;

  const config = {
    ...DEFAULT_CONFIG,
    ...(input.discount?.metafield?.value
      ? JSON.parse(input.discount.metafield.value)
      : {}),
  };

  const isTapcartUser = cart.attribute?.value === config.channelValue;

  if (config.appExclusive && !isTapcartUser) {
    return { operations: [] };
  }

  if (!isCustomerEligible(cart.customer, cart.buyerIdentity, config)) {
    return { operations: [] };
  }

  if (!checkAdditionalEligibility(cart.customer, cart.buyerIdentity, config)) {
    return { operations: [] };
  }

  if (config.startDate || config.endDate) {
    const now = new Date();
    const start = config.startDate ? new Date(config.startDate) : null;
    const end = config.endDate ? new Date(config.endDate) : null;

    if (start && now < start) return { operations: [] };
    if (end && now > end) return { operations: [] };
  }

  const subtotalValue = parseFloat(cart.cost?.subtotalAmount?.amount || "0");

  if (
    (config.discountMethod === "amount_off_order" || config.discountMethod === "free_shipping") &&
    subtotalValue < config.minimumOrderAmount
  ) {
    return { operations: [] };
  }

  const operations = [];

  switch (config.discountMethod) {
    case "amount_off_products": {
      if (config.productDiscountAmount > 0 || config.productDiscountPercentage > 0) {
        const productLines = cart.lines.filter(
          (line) => line.merchandise?.__typename === "ProductVariant"
        );

        if (productLines.length > 0) {
          operations.push({
            productDiscountsAdd: {
              candidates: productLines.map((line) => ({
                message: DISCOUNT_DESCRIPTION,
                targets: [{ cartLine: { id: line.id } }],
                value:
                  config.productDiscountAmount > 0
                    ? { fixedAmount: { amount: config.productDiscountAmount.toString() } }
                    : { percentage: { value: config.productDiscountPercentage } },
              })),
              selectionStrategy: ProductDiscountSelectionStrategy.First,
            },
          });
        }
      }
      break;
    }

    case "buy_x_get_y": {
      const productLines = cart.lines.filter(
        (line) => line.merchandise?.__typename === "ProductVariant"
      );

      if (productLines.length >= config.buyQuantity) {
        const eligibleLines = productLines.slice(0, config.getQuantity);

        operations.push({
          productDiscountsAdd: {
            candidates: eligibleLines.map((line) => ({
              message: DISCOUNT_DESCRIPTION,
              targets: [{ cartLine: { id: line.id } }],
              value:
                config.buyXGetYDiscountType === "free"
                  ? { percentage: { value: 100 } }
                  : config.buyXGetYDiscountType === "percentage"
                  ? { percentage: { value: config.buyXGetYValue } }
                  : { fixedAmount: { amount: config.buyXGetYValue.toString() } },
            })),
            selectionStrategy: ProductDiscountSelectionStrategy.First,
          },
        });
      }
      break;
    }

    case "amount_off_order": {
      if (config.orderDiscountAmount > 0 || config.orderDiscountPercentage > 0) {
        operations.push({
          orderDiscountsAdd: {
            candidates: [
              {
                message: DISCOUNT_DESCRIPTION,
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
                value:
                  config.orderDiscountAmount > 0
                    ? { fixedAmount: { amount: config.orderDiscountAmount.toString() } }
                    : { percentage: { value: config.orderDiscountPercentage } },
              },
            ],
            selectionStrategy: OrderDiscountSelectionStrategy.First,
          },
        });
      }
      break;
    }

    case "free_shipping": {
      if (subtotalValue >= config.freeShippingMinimumAmount) {
        operations.push({
          orderDiscountsAdd: {
            candidates: [
              {
                message: DISCOUNT_DESCRIPTION,
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
                value: { percentage: { value: 100 } },
              },
            ],
            selectionStrategy: OrderDiscountSelectionStrategy.First,
          },
        });
      }
      break;
    }
  }

  return { operations };
}

export default cartLinesDiscountsGenerateRun;
