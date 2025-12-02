import { json } from "@remix-run/node";

// Simple in-memory storage for configuration
// Falls back to file cache when in-memory is empty
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

// Try to load config from file cache
async function loadFromFileCache(shop) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const cacheDir = './cache';
    const shopFileName = shop.replace(/[^a-zA-Z0-9]/g, '-');
    const configPath = path.join(cacheDir, `gwp-config-${shopFileName}.json`);
    
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    
    console.log(`Loaded config from file cache for ${shop}`);
    
    // Store in memory for faster subsequent access
    const canonicalKey = normalizeHost(shop);
    shopConfigs.set(canonicalKey, config);
    
    return config;
  } catch (error) {
    // File doesn't exist or couldn't be read
    return null;
  }
}

// Try to find config file by listing cache directory
async function findConfigInCache(shop) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const cacheDir = './cache';
    const files = await fs.readdir(cacheDir);
    
    // Look for any gwp-config file
    const configFiles = files.filter(f => f.startsWith('gwp-config-') && f.endsWith('.json'));
    
    if (configFiles.length === 0) return null;
    
    // If only one config file exists, use it (single-tenant fallback)
    if (configFiles.length === 1) {
      const configPath = path.join(cacheDir, configFiles[0]);
      const configData = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);
      
      console.log(`Using single config file ${configFiles[0]} for ${shop}`);
      
      // Store in memory with the requesting shop as key
      const canonicalKey = normalizeHost(shop);
      shopConfigs.set(canonicalKey, config);
      
      return config;
    }
    
    return null;
  } catch (error) {
    return null;
  }
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
    
    // console.debug('Config API called with shop:', shop);

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
    let config = resolvedKey ? shopConfigs.get(resolvedKey) : null;
    
    // If not in memory, try to load from file cache
    if (!config) {
      console.log('Config not in memory, trying file cache for:', shop);
      config = await loadFromFileCache(shop);
    }
    
    // If still not found, try to find any config file (single-tenant fallback)
    if (!config) {
      config = await findConfigInCache(shop);
    }
    
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

    // Auto-learn alias if exactly one config exists in memory
    if (shopConfigs.size === 1) {
      const onlyKey = Array.from(shopConfigs.keys())[0];
      const fallbackConfig = shopConfigs.get(onlyKey);
      const aliasKey = normalizeHost(shop);
      if (aliasKey && aliasKey !== onlyKey) {
        aliasToShop.set(aliasKey, onlyKey);
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

    // Return empty configuration if none exists
    console.log('No configuration found for shop:', shop);
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

    // console.debug('Configuration updated for shop:', canonicalKey);
    // console.debug('Aliases now:', Array.from(aliasToShop.entries()));

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