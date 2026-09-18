import { json } from "@remix-run/node";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * This route used to proxy Admin GraphQL via unauthenticated.admin(shop).
 * That is closed. Hydrogen should read the storefront-public shop metafield:
 *   shop { metafield(namespace: "gwp", key: "config") { value } }
 */
export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return json(
    {
      error: "This endpoint no longer serves GWP config.",
      use: "Storefront API shop metafield namespace=gwp key=config",
    },
    { status: 410, headers: corsHeaders }
  );
};

export const action = async () => {
  return new Response(null, {
    status: 405,
    headers: { ...corsHeaders, Allow: "GET, OPTIONS" },
  });
};
