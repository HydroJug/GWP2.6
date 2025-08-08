import { json } from "@remix-run/node";

// Simple in-memory storage for configuration
// In production, you'd want to use a database or external storage
let shopConfigs = new Map();
// Map custom domains (and other aliases) to canonical myshopify shop
let aliasToShop = new Map();

function normalizeHost(host) {
  if (!host) return '';
  try {
    return host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  } catch {
    return host.toLowerCase();
  }
}

function toggleWww(host) {
  if (!host) return host;
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

function resolveShopKey(inputHost) {
  const host = normalizeHost(inputHost);
  if (!host) return null;
  // Direct hit
  if (shopConfigs.has(host)) return host;
  // Alias mapping
  const mapped = aliasToShop.get(host);
  if (mapped && shopConfigs.has(mapped)) return mapped;
  // Try toggling www/apex
  const toggled = toggleWww(host);
  if (shopConfigs.has(toggled)) return toggled;
  const mappedToggled = aliasToShop.get(toggled);
  if (mappedToggled && shopConfigs.has(mappedToggled)) return mappedToggled;
  return null;
}

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

    // Resolve configuration by shop or alias
    const resolvedKey = resolveShopKey(shop);
    const config = resolvedKey ? shopConfigs.get(resolvedKey) : null;
    
    console.log('Config API called for shop:', shop);
    console.log('Resolved key:', resolvedKey);
    console.log('Available configs:', Array.from(shopConfigs.keys()));
    console.log('Known aliases:', Array.from(aliasToShop.entries()));
    console.log('Found config:', config);
    
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

    // Auto-learn alias if exactly one config exists
    if (shopConfigs.size === 1) {
      const onlyKey = Array.from(shopConfigs.keys())[0];
      const fallbackConfig = shopConfigs.get(onlyKey);
      const aliasKey = normalizeHost(shop);
      if (aliasKey && aliasKey !== onlyKey) {
        aliasToShop.set(aliasKey, onlyKey);
        console.log('Alias learned:', aliasKey, '->', onlyKey);
      }
      return json({
        tiers: fallbackConfig.tiers,
        progressBar: fallbackConfig.progressBar,
        isActive: fallbackConfig.isActive,
        message: "Configuration loaded (alias learned)"
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
    const { shop, config, aliases } = body;

    if (!shop || !config) {
      return json({
        error: "Missing shop or config parameter"
      }, {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Store the configuration under canonical key
    const canonicalKey = normalizeHost(shop);
    shopConfigs.set(canonicalKey, config);

    // Optionally record aliases (custom domains, www/apex)
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        const alias = normalizeHost(a);
        if (alias && alias !== canonicalKey) {
          aliasToShop.set(alias, canonicalKey);
        }
      }
    }

    console.log('Configuration updated for shop:', canonicalKey);
    console.log('Aliases now:', Array.from(aliasToShop.entries()));

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