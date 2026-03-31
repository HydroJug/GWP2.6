/**
 * Shared utilities for querying and displaying app discounts.
 */

export const DISCOUNT_LIST_QUERY = `
  query DiscountList {
    discountNodes(first: 250, sortKey: CREATED_AT, reverse: true) {
      nodes {
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
      }
    }
  }
`;

/**
 * Filter raw GraphQL discount list results to only those belonging to given functionId(s).
 * Accepts a single ID string or an array of IDs to handle multiple function versions.
 */
export function filterDiscountsByFunction(data, functionIds) {
  if (!functionIds || !data) return [];
  const idSet = new Set(Array.isArray(functionIds) ? functionIds : [functionIds]);
  if (idSet.size === 0) return [];

  const nodes = data.discountNodes?.nodes ?? [];

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
