import { authenticate } from "../shopify.server";
import {
  syncGWPActiveState,
  enforceSingleActiveGWP,
} from "../lib/storage.server";

/**
 * Handles discounts/create, discounts/update and discounts/delete.
 *
 * Any discount status change can affect whether a GWP discount is currently
 * active, which controls whether gift tiers render on the storefront progress
 * bar. We recompute and persist that state on every discount event so the
 * progress bar follows the live discount status — including when a discount is
 * paused, resumed, or deleted from the native Shopify admin (outside the app).
 */
export const action = async ({ request }) => {
  const { shop, topic, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // admin is undefined if the shop has uninstalled — nothing to sync then.
  if (admin) {
    try {
      // If a GWP discount was just activated in the native admin, two could now
      // be live. Keep only the most-recently-updated one. This is a no-op when
      // 0 or 1 GWP discounts are active, so it won't fight normal edits. The
      // resulting deactivations fire more discounts/update webhooks, but those
      // are deactivations (≤1 active), so this terminates — no loop.
      await enforceSingleActiveGWP(admin);
    } catch (err) {
      console.error("[webhooks/discounts] enforce failed:", err.message);
    }
    try {
      const isActive = await syncGWPActiveState(admin, shop);
      console.log(`[webhooks/discounts] Synced GWP isActive=${isActive} for ${shop}`);
    } catch (err) {
      console.error("[webhooks/discounts] sync failed:", err.message);
    }
  }

  return new Response();
};
