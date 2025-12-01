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
    
    // Create a mock admin session for the shop
    // Note: This is a simplified approach - in production you might want to use a different method
    // to access the shop's configuration without requiring full authentication
    
    // For now, we'll use the cached config approach but with better error handling
    const cachedConfig = await loadCachedConfig(shop);
    if (cachedConfig && cachedConfig.tiers && cachedConfig.tiers.length > 0) {
      console.log('Successfully loaded cached configuration');
      return cachedConfig;
    }
    
    console.log('No cached config found or config was empty');
    return null;
  } catch (error) {
    console.error('Error fetching config from Shopify:', error);
    return null;
  }
}

// Function to load cached configuration
async function loadCachedConfig(shop) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Create a shop-specific config file
    const configDir = './cache';
    const configPath = path.join(configDir, `gwp-config-${shop.replace(/[^a-zA-Z0-9]/g, '-')}.json`);
    
    console.log(`Looking for cached config at: ${configPath}`);
    console.log(`Shop parameter: ${shop}`);
    console.log(`Sanitized shop name: ${shop.replace(/[^a-zA-Z0-9]/g, '-')}`);
    
    // Check if the config file exists
    try {
      await fs.access(configPath);
      console.log(`Cache file found at: ${configPath}`);
    } catch (accessError) {
      console.log(`No cached config found for shop: ${shop} at path: ${configPath}`);
      console.log(`Access error:`, accessError.message);
      
      // Try to list what files are in the cache directory
      try {
        const files = await fs.readdir(configDir);
        console.log(`Files in cache directory:`, files);
      } catch (readdirError) {
        console.log(`Could not read cache directory:`, readdirError.message);
      }
      
      return null;
    }
    
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    
    console.log(`Loaded cached config for ${shop}, ${config.tiers?.length || 0} tiers`);
    return config;
  } catch (error) {
    console.error('Error loading cached config:', error);
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
        tiers: JSON.stringify([]),
        is_active: false,
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
        tiers: JSON.stringify(config.tiers),
        is_active: config.isActive !== false, // Default to true if not specified
        message: "Configuration loaded from admin interface"
      }, {
        headers: corsHeaders,
      });
    }

    // If no configuration found, return empty configuration
    console.log('No configuration found, returning empty configuration');
    return json({
      tiers: JSON.stringify([]),
      is_active: false,
      message: "No configuration found - please configure in admin interface"
    }, {
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error in public GWP settings API:', error);
    return json({
      tiers: JSON.stringify([]),
      is_active: false,
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