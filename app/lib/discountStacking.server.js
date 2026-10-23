// Lets a free etch discount and other product discounts apply to the same cart
// line. Shopify allows only one product discount per line unless both discounts
// agree through tags (Shopify Plus only): each must list a tag the other has in
// combinesWith.productDiscountsWithTagsOnSameCartLine.
//
// Free etch discounts are tagged FREE_ETCH_TAG and accept STACKS_WITH_TAG.
// Other discounts are tagged STACKS_WITH_TAG and accept FREE_ETCH_TAG. Using two
// tags keeps two free etch discounts from stacking with each other.
//
// The tags live on the other discounts, so stacking is store-wide: a discount
// that stacks with one free etch discount stacks with all of them.

export const FREE_ETCH_TAG = "free-etch";
export const STACKS_WITH_TAG = "stacks-with-free-etch";
// Same-line stacking requires combinesWith.productDiscounts. When enabling has to
// turn that on, this tag records it so disabling can turn it back off.
const TURNED_ON_PRODUCT_COMBOS_TAG = "free-etch-turned-on-product-combos";

// productDiscountsWithTagsOnSameCartLine and discount tags need 2026-04 or later.
export const STACKING_API_VERSION = "2026-07";

// The store has thousands of code discounts, so never list them all: list the
// automatic ones and the ones already stacking, and search codes by name.
const BASE_QUERY = "status:active,scheduled";
const MAX_PAGES = 5;
const SEARCH_LIMIT = 25;

const DISCOUNT_FIELDS = `title status discountClasses tags
  combinesWith { orderDiscounts productDiscounts shippingDiscounts productDiscountsWithTagsOnSameCartLine }`;

const DISCOUNT_SELECTION = `
  id
  discount {
    __typename
    ... on DiscountAutomaticBasic { ${DISCOUNT_FIELDS} }
    ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} }
    ... on DiscountAutomaticBxgy { ${DISCOUNT_FIELDS} }
    ... on DiscountCodeBxgy { ${DISCOUNT_FIELDS} }
    ... on DiscountAutomaticApp { ${DISCOUNT_FIELDS} appDiscountType { functionId } }
    ... on DiscountCodeApp { ${DISCOUNT_FIELDS} appDiscountType { functionId } }
  }`;

const LIST_DISCOUNTS = `query StackableDiscounts($first: Int!, $after: String, $query: String!) {
  discountNodes(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { ${DISCOUNT_SELECTION} }
  }
}`;

const GET_DISCOUNT = `query StackableDiscount($id: ID!) {
  discountNode(id: $id) { ${DISCOUNT_SELECTION} }
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

// A product discount a free etch discount could stack with, or null. Pass the
// free etch function's ID to also exclude free etch discounts saved before they
// were tagged.
function toStackable(node, freeEtchFunctionId) {
  const d = node?.discount;
  if (!d?.discountClasses?.includes("PRODUCT")) return null;
  if (d.tags?.includes(FREE_ETCH_TAG)) return null;
  if (freeEtchFunctionId && d.appDiscountType?.functionId === freeEtchFunctionId) return null;
  return {
    id: node.id,
    type: d.__typename,
    title: d.title,
    status: d.status,
    tags: d.tags ?? [],
    combinesWith: d.combinesWith,
    stacks: Boolean(
      d.tags?.includes(STACKS_WITH_TAG) &&
        (d.combinesWith?.productDiscountsWithTagsOnSameCartLine ?? []).includes(FREE_ETCH_TAG)
    ),
  };
}

async function listDiscounts(admin, freeEtchFunctionId, filter, { first = 100, maxPages = MAX_PAGES } = {}) {
  const discounts = [];
  let truncated = false;
  let after = null;
  for (let page = 0; ; page++) {
    const data = await gql(admin, LIST_DISCOUNTS, { first, after, query: `${BASE_QUERY} ${filter}` });
    const conn = data.discountNodes;
    for (const node of conn.nodes) {
      const d = toStackable(node, freeEtchFunctionId);
      if (d) discounts.push(d);
    }
    if (!conn.pageInfo.hasNextPage) break;
    if (page + 1 >= maxPages) {
      truncated = true;
      break;
    }
    after = conn.pageInfo.endCursor;
  }
  return { discounts, truncated };
}

/**
 * Active and scheduled automatic product discounts, plus any discount already
 * stacking with free etch, excluding free etch discounts themselves.
 */
export async function listStackableDiscounts(admin, freeEtchFunctionId) {
  const [automatic, stacking] = await Promise.all([
    listDiscounts(admin, freeEtchFunctionId, "method:automatic"),
    listDiscounts(admin, freeEtchFunctionId, `tag:${STACKS_WITH_TAG}`),
  ]);
  const byId = new Map();
  // Filter on stacks too, in case the tag search matches loosely.
  for (const d of [...automatic.discounts, ...stacking.discounts.filter((d) => d.stacks)]) byId.set(d.id, d);
  return { discounts: [...byId.values()], truncated: automatic.truncated || stacking.truncated };
}

/** Active and scheduled code product discounts matching a search term. */
export async function searchStackableDiscounts(admin, freeEtchFunctionId, term) {
  // Quoted terms match nothing in discount search, so pass plain words.
  // A leading "-" would exclude the word instead.
  const cleaned = term
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/(^|\s)-+/g, "$1")
    .trim();
  if (!cleaned) return [];
  const { discounts } = await listDiscounts(admin, freeEtchFunctionId, `method:code ${cleaned}`, {
    first: SEARCH_LIMIT,
    maxPages: 1,
  });
  return discounts;
}

/** One discount by node ID, or null if it can't stack with free etch. */
export async function getStackableDiscount(admin, id, freeEtchFunctionId) {
  const data = await gql(admin, GET_DISCOUNT, { id });
  return toStackable(data.discountNode, freeEtchFunctionId);
}

/**
 * Turns same-line stacking with free etch on or off for one discount from
 * listStackableDiscounts. Returns an error message, or null on success.
 */
export async function setStacksWithFreeEtch(admin, discount, enabled) {
  const mutation = UPDATE_MUTATIONS[discount.type];
  if (!mutation) return `${discount.title}: this discount type can't be updated`;
  const [field, arg, inputType] = mutation;

  const { orderDiscounts, productDiscounts, shippingDiscounts } = discount.combinesWith;
  const otherTags = discount.tags.filter((t) => t !== STACKS_WITH_TAG && t !== TURNED_ON_PRODUCT_COMBOS_TAG);
  const turnedOnProductCombos = discount.tags.includes(TURNED_ON_PRODUCT_COMBOS_TAG);
  let tags;
  let combinesWithProducts;
  if (enabled) {
    const turningOn = !productDiscounts || turnedOnProductCombos;
    tags = [...otherTags, STACKS_WITH_TAG, ...(turningOn ? [TURNED_ON_PRODUCT_COMBOS_TAG] : [])];
    combinesWithProducts = true;
  } else {
    tags = otherTags;
    combinesWithProducts = turnedOnProductCombos ? false : productDiscounts;
  }

  // Booleans left out of combinesWith reset to false, so resend the current ones.
  const input = {
    tags,
    combinesWith: {
      orderDiscounts,
      productDiscounts: combinesWithProducts,
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
