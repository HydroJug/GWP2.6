const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const BULK_ADD_LIMIT = 250;

export function normalizePrefix(raw) {
  const clean = (raw || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/-+$/g, "");
  if (!clean) return "";
  return clean.endsWith("-") ? clean : `${clean}-`;
}

function randomSuffix(length = 10) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export function generateCodes(prefix, count) {
  const codes = [];
  const seen = new Set();
  let guard = 0;
  while (codes.length < count && guard < count * 20) {
    guard += 1;
    const code = `${prefix}${randomSuffix()}`;
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export async function fetchCodesCount(admin, nodeId) {
  const res = await admin.graphql(
    `query CodesCount($id: ID!) {
      discountNode(id: $id) {
        discount {
          ... on DiscountCodeApp {
            codesCount { count precision }
          }
        }
      }
    }`,
    { variables: { id: nodeId } }
  );
  const c = (await res.json()).data?.discountNode?.discount?.codesCount;
  return { count: c?.count ?? 0, precision: c?.precision ?? "EXACT" };
}

export async function fetchBulkCreation(admin, jobId) {
  const res = await admin.graphql(
    `query BulkCreation($id: ID!) {
      discountRedeemCodeBulkCreation(id: $id) {
        id
        done
        codesCount
        importedCount
        failedCount
      }
    }`,
    { variables: { id: jobId } }
  );
  return (await res.json()).data?.discountRedeemCodeBulkCreation ?? null;
}

export async function startRedeemCodeBulkAdd(admin, discountNodeId, codes) {
  if (!codes.length) throw new Error("No codes to add.");
  if (codes.length > BULK_ADD_LIMIT) {
    throw new Error(`Shopify accepts at most ${BULK_ADD_LIMIT} codes per batch.`);
  }
  const res = await admin.graphql(
    `mutation DiscountRedeemCodeBulkAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
      discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
        bulkCreation { id }
        userErrors { field message }
      }
    }`,
    { variables: { discountId: discountNodeId, codes: codes.map((code) => ({ code })) } }
  );
  const data = await res.json();
  const errors = data.data?.discountRedeemCodeBulkAdd?.userErrors ?? [];
  if (errors.length) throw new Error(errors[0].message);
  if (data.errors) throw new Error(data.errors[0].message);
  const jobId = data.data?.discountRedeemCodeBulkAdd?.bulkCreation?.id;
  if (!jobId) throw new Error("Shopify did not start a bulk code job.");
  return jobId;
}

export async function fetchCodePage(admin, nodeId, cursor, options = {}) {
  const first = Math.min(250, Math.max(1, parseInt(options.first, 10) || 250));
  const query = (options.query || "").trim() || null;
  const res = await admin.graphql(
    `query DiscountCodes($id: ID!, $cursor: String, $query: String, $first: Int!) {
      discountNode(id: $id) {
        discount {
          ... on DiscountCodeApp {
            codesCount { count }
            codes(first: $first, after: $cursor, query: $query) {
              pageInfo { hasNextPage hasPreviousPage endCursor }
              edges { node { code asyncUsageCount } }
            }
          }
        }
      }
    }`,
    { variables: { id: nodeId, cursor, query, first } }
  );
  const discount = (await res.json()).data?.discountNode?.discount;
  const edges = discount?.codes?.edges ?? [];
  return {
    codes: edges.map((e) => e.node.code),
    items: edges.map((e) => ({
      code: e.node.code,
      usage: e.node.asyncUsageCount ?? 0,
    })),
    hasNextPage: discount?.codes?.pageInfo?.hasNextPage ?? false,
    hasPreviousPage: discount?.codes?.pageInfo?.hasPreviousPage ?? false,
    endCursor: discount?.codes?.pageInfo?.endCursor ?? null,
    total: discount?.codesCount?.count ?? 0,
  };
}

export async function readConfig(admin, nodeId) {
  const res = await admin.graphql(
    `query($id: ID!) {
      discountNode(id: $id) {
        metafield(namespace: "bulk_discount", key: "config") { value }
      }
    }`,
    { variables: { id: nodeId } }
  );
  const raw = (await res.json()).data?.discountNode?.metafield?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeConfig(admin, nodeId, config) {
  await admin.graphql(
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          { ownerId: nodeId, namespace: "bulk_discount", key: "config", type: "json", value: JSON.stringify(config) },
        ],
      },
    }
  );
}
