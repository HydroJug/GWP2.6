import { createHmac, timingSafeEqual } from "node:crypto";

// Shared by the Gorgias customer-tags endpoint and the in-app Gorgias setup page.

const SHOPIFY_API_VERSION = "2025-07";
const DEFAULT_ALLOWED_TAGS = "FREELID";

export function normalizeShopDomain(value) {
  const shop = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

export function allowedGorgiasTags() {
  return (process.env.GORGIAS_ALLOWED_TAGS || DEFAULT_ALLOWED_TAGS)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Each store gets its own hook secret, derived from GORGIAS_HOOK_SECRET, so a
 * secret leaked from one store's Gorgias can't tag customers in another store.
 * Returns null when the master secret isn't configured.
 */
export function gorgiasSecretForShop(shop) {
  const master = process.env.GORGIAS_HOOK_SECRET;
  if (!master || !shop) return null;
  return createHmac("sha256", master).update(`gorgias-hook:${shop}`).digest("hex");
}

export function verifyGorgiasSecret(authorizationHeader, shop) {
  const expected = gorgiasSecretForShop(shop);
  if (!expected) return false;
  const provided = Buffer.from(authorizationHeader?.replace(/^Bearer\s+/i, "") ?? "");
  const expectedBuf = Buffer.from(expected);
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
}

const tokenCache = new Map();

/**
 * Admin token for `shop` via the client credentials grant. Only works for
 * stores in the app's own Shopify organization. App sessions can't be used
 * here because they're kept in memory and don't survive between serverless
 * invocations.
 */
export async function getShopifyAdminToken(shop) {
  const cached = tokenCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `token request failed (${res.status}): ${data.error_description ?? data.error ?? "no access_token"}`
    );
  }

  const token = {
    value: data.access_token,
    scopes: String(data.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    expiresAt: Date.now() + (data.expires_in ?? 86399) * 1000 - 5 * 60 * 1000,
  };
  tokenCache.set(shop, token);
  return token;
}

const TAGS_ADD = `mutation AddCustomerTags($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}`;

/** Returns `{ ok: true }` or `{ ok: false, status, error }`. */
export async function addCustomerTags(shop, customerGid, tags) {
  let token;
  try {
    token = await getShopifyAdminToken(shop);
  } catch (err) {
    console.error(`[gorgias] ${shop}:`, err.message);
    return { ok: false, status: 502, error: "Could not authenticate with Shopify" };
  }

  let data;
  try {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token.value,
      },
      body: JSON.stringify({ query: TAGS_ADD, variables: { id: customerGid, tags } }),
    });
    data = await res.json().catch(() => ({}));
    if (res.status === 401) tokenCache.delete(shop);
    if (!res.ok) {
      console.error(`[gorgias] ${shop}: Shopify HTTP ${res.status}`, JSON.stringify(data));
      return { ok: false, status: 502, error: `Shopify responded ${res.status}` };
    }
  } catch (err) {
    console.error(`[gorgias] ${shop}: request failed:`, err.message);
    return { ok: false, status: 502, error: "Could not reach Shopify" };
  }

  const errors = [
    ...(data.errors ?? []).map((e) => e.message),
    ...(data.data?.tagsAdd?.userErrors ?? []).map((e) => e.message),
  ];
  if (errors.length > 0 || !data.data?.tagsAdd?.node) {
    console.error(`[gorgias] ${shop}: tagsAdd failed:`, errors);
    return { ok: false, status: 422, error: errors[0] ?? "Customer not found" };
  }
  return { ok: true };
}

/** For the setup page: can the endpoint get a token for this shop, with write_customers? */
export async function checkGorgiasConnection(shop) {
  try {
    const token = await getShopifyAdminToken(shop);
    if (!token.scopes.includes("write_customers")) {
      return {
        ok: false,
        message:
          "Connected, but the write_customers permission isn't approved on this store yet. Deploy the app config and approve the new permission.",
      };
    }
    return { ok: true, message: "Connected. The endpoint can add tags to customers in this store." };
  } catch (err) {
    const notPermitted = /shop_not_permitted|cannot be performed on this shop/i.test(err.message);
    return {
      ok: false,
      message: notPermitted
        ? "This store isn't in the app's Shopify organization, so the endpoint can't get a token for it."
        : `Couldn't get a Shopify token: ${err.message}`,
    };
  }
}
