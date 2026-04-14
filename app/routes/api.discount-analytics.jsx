import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Fetches order-level analytics for a single discount.
 * Query params:
 *   title  – discount title (used for automatic discounts)
 *   code   – discount code (used for code discounts, preferred filter)
 *
 * Returns: { timesUsed, grossRevenue, discountAmount, otherDiscounts, netRevenue }
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const title = url.searchParams.get("title");

  if (!code && !title) {
    return json({ error: "code or title is required" }, { status: 400 });
  }

  // Build order query — discount_code filter matches both code discounts and automatic discount titles
  const filterValue = code || title;
  const orderQuery = `discount_code:'${filterValue.replace(/'/g, "\\'")}'`;

  let allOrders = [];
  let cursor = null;
  let hasNext = true;
  const MAX_PAGES = 4; // Cap at ~1000 orders for performance
  let page = 0;

  while (hasNext && page < MAX_PAGES) {
    const res = await admin.graphql(
      `query OrderAnalytics($query: String!, $cursor: String) {
        orders(first: 250, query: $query, after: $cursor, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            currentSubtotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            discountApplications(first: 20) {
              nodes {
                index
                ... on DiscountCodeApplication { code }
                ... on AutomaticDiscountApplication { title }
              }
            }
            lineItems(first: 100) {
              nodes {
                discountAllocations {
                  allocatedAmountSet { shopMoney { amount } }
                  discountApplication { index }
                }
              }
            }
          }
        }
      }`,
      { variables: { query: orderQuery, cursor } }
    );

    const data = await res.json();
    const orders = data.data?.orders;
    if (!orders) break;

    allOrders.push(...orders.nodes);
    hasNext = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
    page++;
  }

  // Aggregate analytics
  let timesUsed = 0;
  let grossRevenue = 0;
  let discountAmount = 0;
  let otherDiscounts = 0;
  let netRevenue = 0;

  for (const order of allOrders) {
    timesUsed++;

    const subtotal = parseFloat(order.currentSubtotalPriceSet?.shopMoney?.amount ?? "0");
    const totalDiscount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount ?? "0");

    netRevenue += subtotal;
    grossRevenue += subtotal + totalDiscount;

    // Find the matching discount application index
    const matchingIndices = new Set();
    for (const app of (order.discountApplications?.nodes ?? [])) {
      const appCode = app.code;
      const appTitle = app.title;
      if (
        (code && appCode && appCode.toLowerCase() === code.toLowerCase()) ||
        (title && appTitle && appTitle.toLowerCase() === title.toLowerCase())
      ) {
        matchingIndices.add(app.index);
      }
    }

    // Sum allocations for matching vs other discounts
    let thisDiscountTotal = 0;
    let otherDiscountTotal = 0;
    for (const lineItem of (order.lineItems?.nodes ?? [])) {
      for (const alloc of (lineItem.discountAllocations ?? [])) {
        const amount = parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount ?? "0");
        if (matchingIndices.has(alloc.discountApplication?.index)) {
          thisDiscountTotal += amount;
        } else {
          otherDiscountTotal += amount;
        }
      }
    }

    discountAmount += thisDiscountTotal;
    otherDiscounts += otherDiscountTotal;
  }

  return json({
    timesUsed,
    grossRevenue: grossRevenue.toFixed(2),
    discountAmount: discountAmount.toFixed(2),
    otherDiscounts: otherDiscounts.toFixed(2),
    netRevenue: netRevenue.toFixed(2),
    capped: hasNext, // true if we hit the page cap and there are more orders
  });
};
