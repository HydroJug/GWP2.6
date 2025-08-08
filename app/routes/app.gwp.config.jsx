import { json } from "@remix-run/node";

// Simple in-memory storage for configuration
// In production, you'd want to use a database or external storage
let shopConfigs = new Map();

// Add CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

export const loader = async ({ request }) => {
  try {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Get shop parameter from URL
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');
    
    console.log('Config API called with shop:', shop);

    if (!shop) {
      return json({
        error: "No shop parameter provided"
      }, {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get configuration for the shop
    const config = shopConfigs.get(shop);
    
    if (config) {
      console.log('Returning configuration for shop:', shop);
      return json({
        tiers: config.tiers,
        progressBar: config.progressBar,
        isActive: config.isActive,
        message: "Configuration loaded"
      }, {
        headers: corsHeaders,
      });
    }

    // Return default configuration if none exists
    console.log('No configuration found for shop:', shop, 'returning default');
    return json({
      tiers: [],
      progressBar: null,
      isActive: false,
      message: "No configuration found - please configure in admin interface"
    }, {
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error in config API:', error);
    return json({
      error: "Internal server error"
    }, {
      status: 500,
      headers: corsHeaders,
    });
  }
};

export const action = async ({ request }) => {
  try {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: corsHeaders,
      });
    }

    if (request.method !== "POST") {
      return json({
        error: "Method not allowed"
      }, {
        status: 405,
        headers: corsHeaders,
      });
    }

    const body = await request.json();
    const { shop, config } = body;

    if (!shop || !config) {
      return json({
        error: "Missing shop or config parameter"
      }, {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Store the configuration
    shopConfigs.set(shop, config);
    console.log('Configuration updated for shop:', shop);

    return json({
      success: true,
      message: "Configuration updated successfully"
    }, {
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error updating configuration:', error);
    return json({
      error: "Internal server error"
    }, {
      status: 500,
      headers: corsHeaders,
    });
  }
}; 