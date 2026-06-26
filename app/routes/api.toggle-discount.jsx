import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncGWPActiveState, enforceSingleActiveGWP } from "../lib/storage.server";

/**
 * Shared resource route to activate / deactivate a single discount.
 *
 * Body (form data):
 *   discountId   – the discount node GID (gid://shopify/DiscountAutomaticNode/… or …DiscountCodeNode/…)
 *   discountType – "automatic" (default) or "code"
 *   activate     – "true" to activate, "false" to deactivate
 *
 * Used by the per-row toggle in every discount list and the button on each
 * discount detail page (via DiscountStatusToggle).
 */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const discountId = formData.get("discountId");
  const discountType = formData.get("discountType") || "automatic";
  const activate = formData.get("activate") === "true";

  if (!discountId) {
    return json({ error: "Missing discount id." }, { status: 400 });
  }

  // Map (type, desired state) → the correct mutation. Values are from a fixed
  // set, so interpolating them into the query string is safe.
  const isCode = discountType === "code";
  const mutationName = isCode
    ? activate
      ? "discountCodeActivate"
      : "discountCodeDeactivate"
    : activate
      ? "discountAutomaticActivate"
      : "discountAutomaticDeactivate";
  const payloadField = isCode ? "codeDiscountNode" : "automaticDiscountNode";

  try {
    const res = await admin.graphql(
      `mutation toggleDiscount($id: ID!) {
        ${mutationName}(id: $id) {
          ${payloadField} { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: discountId } }
    );
    const data = await res.json();
    const userErrors = data.data?.[mutationName]?.userErrors ?? [];
    if (userErrors.length) return json({ error: userErrors[0].message });
    if (data.errors) return json({ error: data.errors[0].message });

    // Enforce "only one live GWP discount": when a GWP discount is activated,
    // deactivate every other GWP discount. No-ops for non-GWP discounts.
    if (activate) {
      try {
        await enforceSingleActiveGWP(admin, discountId);
      } catch (e) {
        console.error(
          "[toggle-discount] enforceSingleActiveGWP failed (non-fatal):",
          e.message
        );
      }
    }

    // A toggle can change whether a GWP discount is active, which controls the
    // storefront progress bar. Re-sync regardless of which type was toggled
    // (cheap, and only flips the flag when it actually changed).
    try {
      await syncGWPActiveState(admin, session.shop);
    } catch (e) {
      console.error("[toggle-discount] GWP sync failed (non-fatal):", e.message);
    }

    return json({ success: true, activated: activate });
  } catch (err) {
    console.error("[toggle-discount] error:", err.message);
    return json({ error: err.message });
  }
};
