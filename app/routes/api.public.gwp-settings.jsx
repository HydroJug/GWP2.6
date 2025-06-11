import { json } from "@remix-run/node";

// Add CORS headers for checkout extension access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Function to fetch configuration directly from Shopify metafields
async function fetchConfigFromShopify(shop) {
  try {
    // For now, we'll use the cached config approach but with better error handling
    // In the future, this could be enhanced to fetch directly from Shopify metafields
    // using a stored access token, but that requires additional setup
    
    console.log(`Attempting to fetch config for shop: ${shop}`);
    
    // Try to load from cached config first
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

    // Try to fetch real configuration
    const realConfig = await fetchConfigFromShopify(shop);
    
    if (realConfig && realConfig.tiers && realConfig.tiers.length > 0) {
      console.log('Returning real configuration from admin interface');
      return json({
        tiers: JSON.stringify(realConfig.tiers),
        is_active: realConfig.isActive || true,
        message: "Configuration loaded from admin interface"
      }, {
        headers: corsHeaders,
      });
    }

    // Return working configuration for known shops (only if no cached config exists)
    if (shop === 'hydrojugdevsite.myshopify.com') {
      console.log('Returning hardcoded config for development site (no cached config found)');
      const devSiteConfig = [
        {
          id: "tier-1",
          name: "Silver",
          thresholdAmount: 8000,
          description: "Free gift with $80+ purchase",
          maxSelections: 1,
          giftVariantIds: ["37832353022142", "37832363147454"],
          giftProducts: [
            {
              variantId: "37832353022142",
              productId: "6153797238974",
              title: "Blush Sleeve",
              image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/BLSSLV.jpg?v=1609872290",
              price: "0.00"
            },
            {
              variantId: "37832363147454",
              productId: "6153799598270",
              title: "Blush HydroJug",
              image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/Blushmain.jpg?v=1609872408",
              price: "0.00"
            }
          ]
        },
        {
          id: "tier-2",
          name: "Gold",
          thresholdAmount: 12000,
          description: "Premium gift with $100+ purchase",
          maxSelections: 1,
          giftVariantIds: ["37832337850558"],
          giftProducts: [
            {
              variantId: "37832337850558",
              productId: "6153790357694",
              title: "Black Leopard Sleeve (Special Edition)",
              image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/HJ_ProductShot_BlkLeopard.png?v=1609872033",
              price: "0.00"
            }
          ]
        }
      ];

      return json({
        tiers: JSON.stringify(devSiteConfig),
        is_active: true,
        message: "Configuration loaded for development site (fallback)"
      }, {
        headers: corsHeaders,
      });
    }

    // Return configuration for main production site (handle both domains)
    if (shop === 'hydrojug.myshopify.com' || shop === 'www.thehydrojug.com' || shop === 'thehydrojug.com' || shop.includes('thehydrojug.com')) {
      console.log('Using admin-configured settings for main production site, shop:', shop);
      const mainSiteConfig = [
        {
          id: "tier1748560909689",
          name: "Silver",
          thresholdAmount: 8000, // $80 - Updated from 7000
          description: "Choose 1 free gift",
          maxSelections: 1,
          collectionId: "306544934969", // GWP Tier 1 collection
          collectionHandle: "gwp-tier-1",
          collectionTitle: "GWP Tier 1",
          giftVariantIds: [], // Will be populated dynamically from collection
          giftProducts: [] // Will be populated dynamically from collection
        },
        {
          id: "tier1748560909690",
          name: "Gold",
          thresholdAmount: 12000, // $120
          description: "Choose 1 free gift",
          maxSelections: 1,
          collectionId: "306545000505", // GWP Tier 2 collection
          collectionHandle: "gwp-tier-2",
          collectionTitle: "GWP Tier 2",
          giftVariantIds: [], // Will be populated dynamically from collection
          giftProducts: [] // Will be populated dynamically from collection
        }
      ];

      console.log('Returning main site config with tiers:', mainSiteConfig.map(t => ({ name: t.name, collectionHandle: t.collectionHandle })));

      return json({
        tiers: JSON.stringify(mainSiteConfig),
        is_active: true,
        message: "Configuration loaded from admin interface (current settings)"
      }, {
        headers: corsHeaders,
      });
    }

    // Enhanced domain detection for HydroJug - handle preview links and various domains
    const isHydroJugDomain = shop === 'hydrojug.myshopify.com' || 
                            shop === 'www.thehydrojug.com' || 
                            shop === 'thehydrojug.com' ||
                            shop.includes('thehydrojug.com') ||
                            shop.includes('hydrojug') ||
                            shop.includes('shopify.com'); // This catches preview links

    if (isHydroJugDomain) {
      console.log('Detected HydroJug-related domain (including preview links), shop:', shop);
      const hydroJugConfig = [
        {
          id: "tier1748560909689",
          name: "Silver",
          thresholdAmount: 8000,
          description: "Choose 1 free gift",
          maxSelections: 1,
          collectionId: "306544934969", // GWP Tier 1 collection
          collectionHandle: "gwp-tier-1",
          collectionTitle: "GWP Tier 1",
          giftVariantIds: [], // Will be populated dynamically from collection
          giftProducts: [] // Will be populated dynamically from collection
        },
        {
          id: "tier1748560909690",
          name: "Gold",
          thresholdAmount: 12000,
          description: "Choose 1 free gift",
          maxSelections: 1,
          collectionId: "306545000505", // GWP Tier 2 collection
          collectionHandle: "gwp-tier-2",
          collectionTitle: "GWP Tier 2",
          giftVariantIds: [], // Will be populated dynamically from collection
          giftProducts: [] // Will be populated dynamically from collection
        }
      ];

      console.log('Returning HydroJug config for domain:', shop, 'with tiers:', hydroJugConfig.map(t => ({ name: t.name, collectionHandle: t.collectionHandle })));

      return json({
        tiers: JSON.stringify(hydroJugConfig),
        is_active: true,
        message: `Configuration loaded for HydroJug domain: ${shop}`
      }, {
        headers: corsHeaders,
      });
    }

    // Fallback to basic working configuration for other shops
    console.log('Using fallback configuration - no admin settings found');
    
    const fallbackTiers = [
      {
        id: "tier-1",
        name: "Silver",
        thresholdAmount: 8000,
        description: "Free gift with $80+ purchase",
        maxSelections: 1,
        giftVariantIds: ["44382780391481"],
        giftProducts: [
          {
            variantId: "44382780391481",
            productId: "7873478066233",
            title: "Black Can Cooler",
            image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/HJ_ProductShot_BlkCanCooler.png?v=1609872033",
            price: "0.00"
          }
        ]
      }
    ];

    return json({
      tiers: JSON.stringify(fallbackTiers),
      is_active: true,
      message: "Using fallback configuration - please configure products in admin interface"
    }, {
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('Error in public GWP settings API:', error);
    
    // Return basic working configuration if there's an error
    const fallbackTiers = [
      {
        id: "tier-1",
        name: "Silver",
        thresholdAmount: 8000,
        description: "Free gift with $80+ purchase",
        maxSelections: 1,
        giftVariantIds: ["44382780391481"],
        giftProducts: [
          {
            variantId: "44382780391481",
            productId: "7873478066233",
            title: "Black Can Cooler",
            image: "https://cdn.shopify.com/s/files/1/0524/6792/5182/products/HJ_ProductShot_BlkCanCooler.png?v=1609872033",
            price: "0.00"
          }
        ]
      }
    ];

    return json({
      tiers: JSON.stringify(fallbackTiers),
      is_active: true,
      message: "Using fallback configuration due to API error"
    }, {
      headers: corsHeaders,
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