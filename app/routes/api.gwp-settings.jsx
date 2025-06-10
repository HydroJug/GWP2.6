import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getGWPSettings } from "../lib/storage.server";

// Add CORS headers for checkout extension access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async ({ request }) => {
  try {
    // Try to authenticate first
    const { admin, session } = await authenticate.public.appProxy(request);
    
    if (!session?.shop) {
      return json({ 
        error: "No shop found",
        tiers: JSON.stringify([]),
        is_active: false
      }, { 
        status: 400,
        headers: corsHeaders
      });
    }

    const settings = await getGWPSettings(admin, session.shop);
    
    // Return multi-tier settings as JSON string for the checkout extension
    return json({
      tiers: JSON.stringify(settings.tiers || []),
      is_active: settings.isActive
    }, {
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Error fetching GWP settings:', error);
    
    // For checkout extensions, return default empty settings instead of error
    return json({ 
      tiers: JSON.stringify([]),
      is_active: false,
      error: "Settings not available"
    }, { 
      status: 200, // Return 200 so extension doesn't show error
      headers: corsHeaders
    });
  }
};

// Handle OPTIONS requests for CORS preflight
export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }
  
  return json({ error: "Method not allowed" }, { 
    status: 405,
    headers: corsHeaders
  });
}; 