// Lets a free etch discount and other product discounts apply to the same cart
// line. Shopify allows only one product discount per line unless both discounts
// agree through tags (Shopify Plus only): each must list a tag the other has in
// combinesWith.productDiscountsWithTagsOnSameCartLine.
//
// Free etch discounts are tagged FREE_ETCH_TAG and accept STACKS_WITH_TAG.
// Other discounts are tagged STACKS_WITH_TAG and accept FREE_ETCH_TAG. Using two
// tags keeps two free etch discounts from stacking with each other.

export const FREE_ETCH_TAG = "free-etch";
export const STACKS_WITH_TAG = "stacks-with-free-etch";

// productDiscountsWithTagsOnSameCartLine and discount tags need 2026-04 or later.
export const STACKING_API_VERSION = "2026-07";

const DISCOUNT_FIELDS = `title status discountClasses tags
  combinesWith { orderDiscounts productDiscounts shippingDiscounts productDiscountsWithTagsOnSameCartLine }`;

const LIST_DISCOUNTS = `query StackableDiscounts($after: String) {
  discountNodes(first: 100, after: $after, query: "status:active OR status:scheduled") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticBasic { ${DISCOUNT_FIELDS} }
        ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} }
        ... on DiscountAutomaticBxgy { ${DISCOUNT_FIELDS} }
        ... on DiscountCodeBxgy { ${DISCOUNT_FIELDS} }
        ... on DiscountAutomaticApp { ${DISCOUNT_FIELDS} appDiscountType { functionId } }
        ... on DiscountCodeApp { ${DISCOUNT_FIELDS} appDiscountType { functionId } }
      }
    }
  }
}`;

const UPDATE_MUTATIONS = {
  DiscountAutomaticBasic: ["discountAutomaticBasicUpdate", "automaticBasicDiscount", "DiscountAutomaticBasicInput"],
  DiscountCodeBasic: ["discountCodeBasicUpdate", "basicCodeDiscount", "DiscountCodeBasicInput"],
  DiscountAutomaticBxgy: ["discountAutomaticBxgyUpdate", "automaticBxgyDiscount", "DiscountAutomaticBxgyInput"],
  DiscountCodeBxgy: ["discountCodeBxgyUpdate", "bxgyCodeDiscount", "DiscountCodeBxgyInput"],
  DiscountAutomaticApp: ["discountAutomaticAppUpdate", "automaticAppDiscount", "DiscountAutomaticAppInput"],
  DiscountCodeApp: ["discountCodeAppUpdate", "codeAppDiscount", "DiscountCodeAppInput"],
};

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables, apiVersion: STACKING_API_VERSION });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

/**
 * Active and scheduled product discounts that a free etch discount could stack
 * with, excluding free etch discounts themselves. Pass the free etch function's
 * ID to also exclude free etch discounts saved before they were tagged.
 */
export async function listStackableDiscounts(admin, freeEtchFunctionId) {
  const discounts = [];
  let after = null;
  do {
    const data = await gql(admin, LIST_DISCOUNTS, { after });
    const page = data.discountNodes;
    for (const node of page.nodes) {
      const d = node.discount;
      if (!d?.discountClasses?.includes("PRODUCT")) continue;
      if (d.tags?.includes(FREE_ETCH_TAG)) continue;
      if (freeEtchFunctionId && d.appDiscountType?.functionId === freeEtchFunctionId) continue;
      discounts.push({
        id: node.id,
        type: d.__typename,
        title: d.title,
        status: d.status,
        tags: d.tags ?? [],
        combinesWith: d.combinesWith,
        stacks:
          d.tags?.includes(STACKS_WITH_TAG) &&
          (d.combinesWith?.productDiscountsWithTagsOnSameCartLine ?? []).includes(FREE_ETCH_TAG),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return discounts;
}

/**
 * Turns same-line stacking with free etch on or off for one discount from
 * listStackableDiscounts. Returns an error message, or null on success.
 */
export async function setStacksWithFreeEtch(admin, discount, enabled) {
  const mutation = UPDATE_MUTATIONS[discount.type];
  if (!mutation) return `${discount.title}: this discount type can't be updated`;
  const [field, arg, inputType] = mutation;

  const otherTags = discount.tags.filter((t) => t !== STACKS_WITH_TAG);
  // Booleans left out of combinesWith reset to false, so resend the current ones.
  const { orderDiscounts, shippingDiscounts } = discount.combinesWith;
  const input = {
    tags: enabled ? [...otherTags, STACKS_WITH_TAG] : otherTags,
    combinesWith: {
      orderDiscounts,
      productDiscounts: true,
      shippingDiscounts,
      productDiscountsWithTagsOnSameCartLine: enabled
        ? { add: [FREE_ETCH_TAG] }
        : { remove: [FREE_ETCH_TAG] },
    },
  };

  try {
    const data = await gql(
      admin,
      `mutation StackWithFreeEtch($id: ID!, $input: ${inputType}!) {
        ${field}(id: $id, ${arg}: $input) { userErrors { field message } }
      }`,
      { id: discount.id, input }
    );
    const error = data[field]?.userErrors?.[0]?.message;
    return error ? `${discount.title}: ${error}` : null;
  } catch (err) {
    return `${discount.title}: ${err.message}`;
  }
}

/** combinesWith and tags for a free etch discount's own create/update input. */
export function freeEtchStackingInput() {
  return {
    tags: [FREE_ETCH_TAG],
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
      productDiscountsWithTagsOnSameCartLine: { add: [STACKS_WITH_TAG] },
    },
  };
}
