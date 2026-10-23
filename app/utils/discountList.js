/**
 * Shared utilities for querying and displaying app discounts.
 */

const DISCOUNT_LIST_NODE = `
  id
  discount {
    ... on DiscountAutomaticApp {
      title
      status
      startsAt
      endsAt
      appDiscountType { functionId }
    }
    ... on DiscountCodeApp {
      title
      status
      startsAt
      endsAt
      codes(first: 1) { edges { node { code } } }
      appDiscountType { functionId }
      usageLimit
      appliesOncePerCustomer
    }
  }
`;

// The store has thousands of non-app discounts (PostScript creates hundreds of
// codes a day), so an unfiltered "newest 250" page misses this app's discounts.
// Filter to app discounts and page through them, capped as a safety net.
const MAX_PAGES = 20;

/**
 * Every app (function-backed) discount node in the store, newest first.
 * `nodeFields` is the selection for each node; defaults to what the list pages use.
 */
export async function fetchAppDiscountNodes(admin, nodeFields = DISCOUNT_LIST_NODE) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await admin.graphql(
      `query AppDiscountList($after: String) {
        discountNodes(first: 250, after: $after, query: "type:app", sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes { ${nodeFields} }
        }
      }`,
      { variables: { after } }
    );
    const data = await res.json();
    if (data.errors?.length) throw new Error(data.errors[0].message);
    const conn = data.data?.discountNodes;
    nodes.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

/**
 * Filter discount nodes from fetchAppDiscountNodes to those belonging to given functionId(s).
 * Accepts a single ID string or an array of IDs to handle multiple function versions.
 */
export function filterDiscountsByFunction(nodes, functionIds) {
  if (!functionIds || !nodes) return [];
  const idSet = new Set(Array.isArray(functionIds) ? functionIds : [functionIds]);
  if (idSet.size === 0) return [];

  return nodes
    .filter((n) => {
      const d = n.discount;
      return d?.appDiscountType?.functionId && idSet.has(d.appDiscountType.functionId);
    })
    .map((n) => {
      const d = n.discount;
      const isCode = !!d.codes;
      return {
        id: n.id,
        title: d.title,
        discountType: isCode ? "code" : "automatic",
        code: isCode ? (d.codes?.edges?.[0]?.node?.code ?? null) : null,
        status: d.status,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
      };
    })
    .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));
}

export function statusBadgeTone(status) {
  return (
    { ACTIVE: "success", SCHEDULED: "info", EXPIRED: "critical", PAUSED: "warning" }[status] ??
    "subdued"
  );
}

export function formatDate(dateString) {
  if (!dateString) return "—";
  return new Date(dateString).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
