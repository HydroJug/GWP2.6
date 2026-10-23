import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { searchStackableDiscounts } from "../lib/discountStacking.server";

// Code discounts matching ?q= that the free etch editor can stack with.
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const functionId = url.searchParams.get("functionId") || null;

  try {
    const discounts = await searchStackableDiscounts(admin, functionId, q);
    return json({ discounts: discounts.map(({ id, title, status, stacks }) => ({ id, title, status, stacks })) });
  } catch (err) {
    return json({ discounts: [], error: err.message });
  }
};
