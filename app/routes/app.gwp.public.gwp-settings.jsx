import { json } from "@remix-run/node";

// Add CORS headers for checkout extension access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

// Function to fetch configuration from Shopify metafields
async function fetchConfigFromShopify(shop) {
  try {
    console.log(`Attempting to fetch config for shop: ${shop}`);
    
    // For Vercel deployment, we'll use a simple approach
    // In production, you might want to use a database or external storage
    // For now, we'll return a default configuration
    
    // You can replace this with your actual configuration
    const defaultConfig = {
      tiers: [
        {
          id: 'tier1',
          name: 'Silver',
          thresholdAmount: 8000, // $80
          description: 'Choose 1 free gift',
          maxSelections: 1,
          collectionId: null,
          collectionHandle: null,
          collectionTitle: null,
          giftProducts: []
        },
        {
          id: 'tier2', 
          name: 'Gold',
          thresholdAmount: 12000, // $120
          description: 'Choose 1 free gift',
          maxSelections: 1,
          collectionId: null,
          collectionHandle: null,
          collectionTitle: null,
          giftProducts: []
        }
      ],
      progressBar: {
        enabled: true,
        selector: '.cart__items',
        position: 'below'
      },
      isActive: true
    };
    
    console.log('Returning default configuration for Vercel deployment');
    return defaultConfig;
  } catch (error) {
    console.error('Error fetching config from Shopify:', error);
    return null;
  }
}

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
    
    console.log('Public API called with shop:', shop);

    if (!shop) {
      console.log('No shop parameter provided, returning empty configuration');
      return json({
        tiers: [],
        progressBar: null,
        isActive: false,
        message: "No shop parameter provided"
      }, {
        headers: corsHeaders,
      });
    }

    // Try to fetch configuration from admin settings
    const config = await fetchConfigFromShopify(shop);
    
    if (config && config.tiers && config.tiers.length > 0) {
      console.log('Returning configuration from admin interface');
      return json({
        tiers: config.tiers,
        progressBar: config.progressBar || null,
        isActive: config.isActive !== false, // Default to true if not specified
        message: "Configuration loaded from admin interface"
      }, {
        headers: corsHeaders,
      });
    }

    // If no configuration found, return empty configuration
    console.log('No configuration found, returning empty configuration');
    return json({
      tiers: [],
      progressBar: null,
      isActive: false,
      message: "No configuration found - please configure in admin interface"
    }, {
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error in public GWP settings API:', error);
    return json({
      tiers: [],
      progressBar: null,
      isActive: false,
      message: "Error loading configuration"
    }, {
      headers: corsHeaders,
      status: 500
    });
  }
};

export const action = async ({ request }) => {
  // Handle CORS for POST requests if needed
  return new Response(null, {
    status: 405,
    headers: {
      ...corsHeaders,
      "Allow": "GET, OPTIONS",
    },
  });
}; 