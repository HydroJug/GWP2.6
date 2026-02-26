import { DeliveryDiscountSelectionStrategy } from "../generated/api";

const DISCOUNT_DESCRIPTION = "Tapcart App Exclusive Discount";

const DEFAULT_CONFIG = {
  discountMethod: "free_shipping",
  freeShippingMinimumAmount: 50,
  minimumOrderAmount: 0,
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

/**
  * @typedef {import("../generated/api").DeliveryInput} RunInput
  * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
  */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  const { cart } = input;

  const config = input.discount?.metafield?.value
    ? JSON.parse(input.discount.metafield.value)
    : DEFAULT_CONFIG;

  const isTapcartUser = cart.attribute?.value === config.channelValue;

  if (config.appExclusive && !isTapcartUser) {
    return { operations: [] };
  }

  if (!isCustomerEligible(cart.customer, cart.buyerIdentity, config)) {
    return { operations: [] };
  }

  if (config.discountMethod !== "free_shipping") {
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
    subtotalValue < config.minimumOrderAmount ||
    subtotalValue < config.freeShippingMinimumAmount
  ) {
    return { operations: [] };
  }

  const firstDeliveryGroup = cart.deliveryGroups[0];
  if (!firstDeliveryGroup) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: DISCOUNT_DESCRIPTION,
              targets: [{ deliveryGroup: { id: firstDeliveryGroup.id } }],
              value: { percentage: { value: 100 } },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

export default cartDeliveryOptionsDiscountsGenerateRun;
