import { json } from "@remix-run/node";
import { waitUntil } from "@vercel/functions";
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

const SHOPIFY_RESPONSE_BUDGET_MS = 3000;

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

  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    console.warn(`[gorgias/customer-tags] 400: body isn't valid JSON: ${JSON.stringify(raw.slice(0, 200))}`);
    return json({ error: "Body must be JSON" }, { status: 400 });
  }

  const shop = normalizeShopDomain(body?.shop);
  const authorization = request.headers.get("authorization");
  if (!shop || !verifyGorgiasSecret(authorization, shop)) {
    const reason = !shop
      ? `"shop" is missing or not a *.myshopify.com domain (got ${JSON.stringify(body?.shop ?? null)})`
      : !authorization
        ? "no Authorization header"
        : `secret doesn't match the one shown on the Gorgias page for ${shop}`;
    console.warn(`[gorgias/customer-tags] 401: ${reason}`);
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = allowedGorgiasTags();
  const tags = Array.isArray(body?.tags) ? body.tags.map((t) => String(t).trim()) : [];
  const rejected = tags.filter((t) => !allowed.includes(t));
  if (tags.length === 0 || rejected.length > 0) {
    console.warn(
      `[gorgias/customer-tags] 400: ${shop}: ${tags.length ? `tags not allowed: ${rejected.join(", ")}` : "no tags sent"} (allowed: ${allowed.join(", ")})`
    );
    return json(
      { error: "tags must be a non-empty list of allowed tags", rejected, allowed },
      { status: 400 }
    );
  }

  // Problems specific to one ticket answer 200 so Gorgias still sends the
  // agent's message; the failure is only in the logs and the response body.
  // Macro setup mistakes above stay errors so they get noticed and fixed.
  const numericId = String(body?.customerId ?? "")
    .trim()
    .replace(/^gid:\/\/shopify\/Customer\//, "");
  if (!/^\d+$/.test(numericId)) {
    console.warn(
      `[gorgias/customer-tags] not tagged: ${shop}: customerId is ${JSON.stringify(body?.customerId ?? null)}; the ticket's customer is probably not linked to Shopify`
    );
    return json({
      ok: false,
      tagged: false,
      error: "customerId is missing or invalid. Is this ticket's customer linked to Shopify?",
    });
  }

  const customerGid = `gid://shopify/Customer/${numericId}`;
  const startedAt = Date.now();
  const tagging = addCustomerTags(shop, customerGid, tags).then((result) => {
    const ms = Date.now() - startedAt;
    if (result.ok) {
      console.log(`[gorgias/customer-tags] ${shop}: added ${tags.join(", ")} to ${customerGid} (${ms}ms)`);
    } else {
      console.error(`[gorgias/customer-tags] ${shop}: failed to tag ${customerGid} (${ms}ms): ${result.error}`);
    }
    return result;
  });

  // Gorgias fails the macro if the hook takes more than 5s, and a cold start
  // plus a fresh Shopify token can exceed that. If Shopify is slow, answer
  // 202 and let the tagging finish after the response.
  const result = await Promise.race([
    tagging,
    new Promise((resolve) => setTimeout(() => resolve(null), SHOPIFY_RESPONSE_BUDGET_MS)),
  ]);
  if (!result) {
    waitUntil(tagging);
    console.warn(`[gorgias/customer-tags] ${shop}: Shopify is slow; finishing ${customerGid} in the background`);
    return json({ ok: true, pending: true, shop, customerId: customerGid, tags }, { status: 202 });
  }
  if (!result.ok) {
    return json({ ok: false, tagged: false, error: result.error, shopifyStatus: result.status });
  }
  return json({ ok: true, tagged: true, shop, customerId: customerGid, tags });
};
