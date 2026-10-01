import { json } from "@remix-run/node";
import {
  addCustomerTags,
  allowedGorgiasTags,
  normalizeShopDomain,
  verifyGorgiasSecret,
} from "../lib/gorgias.server";

/**
 * Called by a Gorgias macro HTTP hook to add tags to a Shopify customer.
 * Setup values for each store are shown on the app's Gorgias page.
 *
 * POST /api/gorgias/customer-tags
 *   Authorization: Bearer <that store's hook secret>
 *   {
 *     "shop": "store.myshopify.com",
 *     "customerId": "{{ticket.customer.integrations.shopify.customer.id}}",
 *     "tags": ["FREELID"]
 *   }
 *
 * Env:
 *   GORGIAS_HOOK_SECRET   master secret; each store's hook secret is derived from it
 *   GORGIAS_ALLOWED_TAGS  comma-separated allowlist (default: FREELID)
 */

export const loader = () => json({ error: "Method not allowed" }, { status: 405 });

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  if (
    !process.env.GORGIAS_HOOK_SECRET ||
    !process.env.SHOPIFY_API_KEY ||
    !process.env.SHOPIFY_API_SECRET
  ) {
    console.error("[gorgias/customer-tags] missing GORGIAS_HOOK_SECRET or Shopify credentials");
    return json({ error: "Endpoint not configured" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400 });
  }

  const shop = normalizeShopDomain(body?.shop);
  if (!shop || !verifyGorgiasSecret(request.headers.get("authorization"), shop)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const numericId = String(body?.customerId ?? "")
    .trim()
    .replace(/^gid:\/\/shopify\/Customer\//, "");
  if (!/^\d+$/.test(numericId)) {
    return json(
      { error: "customerId is missing or invalid. Is this ticket's customer linked to Shopify?" },
      { status: 400 }
    );
  }

  const allowed = allowedGorgiasTags();
  const tags = Array.isArray(body?.tags) ? body.tags.map((t) => String(t).trim()) : [];
  const rejected = tags.filter((t) => !allowed.includes(t));
  if (tags.length === 0 || rejected.length > 0) {
    return json(
      { error: "tags must be a non-empty list of allowed tags", rejected, allowed },
      { status: 400 }
    );
  }

  const customerGid = `gid://shopify/Customer/${numericId}`;
  const result = await addCustomerTags(shop, customerGid, tags);
  if (!result.ok) {
    return json({ error: result.error }, { status: result.status });
  }

  console.log(`[gorgias/customer-tags] ${shop}: added ${tags.join(", ")} to ${customerGid}`);
  return json({ ok: true, shop, customerId: customerGid, tags });
};
