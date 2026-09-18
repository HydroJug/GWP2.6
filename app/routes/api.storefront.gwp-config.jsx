import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { getGWPSettings, toStorefrontGwpConfig } from "../lib/storage.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=30",
};

function corsJson(body, init = {}) {
  return json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const shop = new URL(request.url).searchParams.get("shop")?.trim();
  if (!shop) {
    return corsJson({ error: "Missing shop query parameter." }, { status: 400 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const settings = await getGWPSettings(admin, shop);
    return corsJson(toStorefrontGwpConfig(settings));
  } catch (error) {
    console.error("Storefront GWP config error:", error);
    return corsJson(
      {
        error: "Could not load GWP config for this shop.",
        isActive: false,
        tiers: [],
        progressBar: null,
      },
      { status: 503 }
    );
  }
};

export const action = async () => {
  return new Response(null, {
    status: 405,
    headers: { ...corsHeaders, Allow: "GET, OPTIONS" },
  });
};
