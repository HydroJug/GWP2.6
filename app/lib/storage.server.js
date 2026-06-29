// Simple metafield-based storage for GWP settings
// No database needed - store directly in Shopify app metafields

export async function getGWPSettings(admin, shop) {
  try {
    const response = await admin.graphql(
      `#graphql
        query getAppMetafield($namespace: String!, $key: String!) {
          currentAppInstallation {
            metafield(namespace: $namespace, key: $key) {
              value
            }
          }
        }`,
      {
        variables: {
          namespace: "gwp_settings",
          key: "config"
        }
      }
    );

    const responseJson = await response.json();
    const metafield = responseJson.data?.currentAppInstallation?.metafield;
    
    if (metafield?.value) {
      const settings = JSON.parse(metafield.value);
      
      // MIGRATION: Fix any old $100 Gold tier thresholds to $120 (12000 cents)
      if (settings.tiers) {
        settings.tiers = settings.tiers.map(tier => {
          if (tier.thresholdAmount === 10000 && (tier.name === 'Gold' || tier.name.toLowerCase().includes('gold'))) {
            console.log(`Migrating ${tier.name} tier from $100 (10000) to $120 (12000)`);
            return {
              ...tier,
              thresholdAmount: 7000
            };
          }
          return tier;
        });
      }
      
      return settings;
    }
    
    // Return default multi-tier settings
    return {
      tiers: [
        {
          id: 'tier1',
          thresholdAmount: 8000, // $80 in cents
          name: 'Silver',
          giftProductIds: [],
          maxSelections: 1, // Customer can select 1 gift
          description: 'Choose 1 free gift'
        }
      ],
      progressBar: {
        enabled: false,
        selector: '',
        position: 'below',
        modalBehavior: 'auto',
        freeShipping: {
          enabled: false,
          threshold: 10000
        }
      },
      isActive: true
    };
  } catch (error) {
    console.error('Error getting GWP settings:', error);
    return {
      tiers: [
        {
          id: 'tier1',
          thresholdAmount: 8000,
          name: 'Silver',
          giftProductIds: [],
          maxSelections: 1,
          description: 'Choose 1 free gift'
        }
      ],
      progressBar: {
        enabled: false,
        selector: '',
        position: 'below',
        modalBehavior: 'auto',
        freeShipping: {
          enabled: false,
          threshold: 10000
        }
      },
      isActive: true
    };
  }
}

// Get or create a Storefront Access Token for the shop
export async function getOrCreateStorefrontToken(admin) {
  try {
    // First, check if we already have a token stored
    const checkResponse = await admin.graphql(
      `#graphql
        query {
          currentAppInstallation {
            metafield(namespace: "gwp_internal", key: "storefront_token") {
              value
            }
          }
        }`
    );
    
    const checkData = await checkResponse.json();
    const existingToken = checkData.data?.currentAppInstallation?.metafield?.value;
    
    if (existingToken) {
      console.log('Using existing Storefront Access Token');
      return existingToken;
    }

    // Next, see if a token already exists for this app installation
    try {
      const listResponse = await admin.graphql(
        `#graphql
          query {
            storefrontAccessTokens(first: 5) {
              edges {
                node {
                  accessToken
                }
              }
            }
          }`
      );
      const listData = await listResponse.json();
      const firstToken = listData.data?.storefrontAccessTokens?.edges?.[0]?.node?.accessToken;
      if (firstToken) {
        console.log('Found existing Storefront Access Token via listing, storing it');
        await storeToken(admin, firstToken);
        return firstToken;
      }
    } catch (listError) {
      console.error('Error listing Storefront Access Tokens (non-fatal):', listError);
    }
    
    // Create a new Storefront Access Token
    console.log('Creating new Storefront Access Token...');
    const createResponse = await admin.graphql(
      `#graphql
        mutation storefrontAccessTokenCreate($input: StorefrontAccessTokenInput!) {
          storefrontAccessTokenCreate(input: $input) {
            storefrontAccessToken {
              accessToken
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            title: "GWP App Storefront Token"
          }
        }
      }
    );
    
    const createData = await createResponse.json();
    
    if (createData.data?.storefrontAccessTokenCreate?.userErrors?.length > 0) {
      console.error('Error creating Storefront token:', 
        createData.data.storefrontAccessTokenCreate.userErrors);
      return null;
    }
    
    const newToken = createData.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
    
    if (!newToken) {
      console.error('No token returned from storefrontAccessTokenCreate:', JSON.stringify(createData));
      return null;
    }
    
    await storeToken(admin, newToken);
    console.log('Storefront Access Token created and stored');
    
    return newToken;
    
  } catch (error) {
    console.error('Error getting/creating Storefront token:', error);
    return null;
  }
}

async function storeToken(admin, token) {
  const appResponse = await admin.graphql(
    `#graphql
      query {
        currentAppInstallation {
          id
        }
      }`
  );
  const appData = await appResponse.json();
  const appInstallationId = appData.data?.currentAppInstallation?.id;
  
  if (appInstallationId) {
    await admin.graphql(
      `#graphql
        mutation saveToken($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { message }
          }
        }`,
      {
        variables: {
          metafields: [{
            ownerId: appInstallationId,
            namespace: "gwp_internal",
            key: "storefront_token",
            type: "single_line_text_field",
            value: token
          }]
        }
      }
    );
  }
}

// Ensure the shop metafield is exposed to Storefront API
async function ensureMetafieldDefinition(admin) {
  try {
    // Check if definition already exists
    const checkResponse = await admin.graphql(
      `#graphql
        query {
          metafieldDefinitions(first: 10, ownerType: SHOP, namespace: "gwp") {
            nodes {
              id
              key
              namespace
            }
          }
        }`
    );
    
    const checkData = await checkResponse.json();
    const existing = checkData.data?.metafieldDefinitions?.nodes?.find(
      d => d.namespace === 'gwp' && d.key === 'config'
    );
    
    if (existing) {
      console.log('Metafield definition already exists:', existing.id);
      return;
    }
    
    // Create the metafield definition with Storefront API access
    console.log('Creating metafield definition for gwp.config...');
    const createResponse = await admin.graphql(
      `#graphql
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          definition: {
            name: "GWP Configuration",
            namespace: "gwp",
            key: "config",
            type: "json",
            ownerType: "SHOP",
            access: {
              storefront: "PUBLIC_READ"
            }
          }
        }
      }
    );
    
    const createData = await createResponse.json();
    if (createData.data?.metafieldDefinitionCreate?.userErrors?.length > 0) {
      console.log('Metafield definition errors (may already exist):', 
        createData.data.metafieldDefinitionCreate.userErrors);
    } else {
      console.log('Metafield definition created:', 
        createData.data?.metafieldDefinitionCreate?.createdDefinition);
    }
  } catch (error) {
    console.log('Error ensuring metafield definition (non-fatal):', error.message);
  }
}

export async function saveGWPSettings(admin, shop, settings) {
  try {
    console.log('Starting saveGWPSettings with:', { shop, settings });
    
    // Ensure the metafield is exposed to Storefront API
    await ensureMetafieldDefinition(admin);
    
    // Get the current app installation ID AND shop ID
    const appResponse = await admin.graphql(
      `#graphql
        query {
          currentAppInstallation {
            id
          }
          shop {
            id
          }
        }`
    );
    
    const appData = await appResponse.json();
    console.log('App installation response:', JSON.stringify(appData, null, 2));
    
    const appInstallationId = appData.data?.currentAppInstallation?.id;
    const shopId = appData.data?.shop?.id;
    
    if (!appInstallationId) {
      console.error('No app installation ID found in response:', appData);
      throw new Error('Could not get app installation ID');
    }

    console.log('Using app installation ID:', appInstallationId);
    console.log('Using shop ID:', shopId);

    const settingsWithTimestamp = {
      ...settings,
      updatedAt: new Date().toISOString()
    };
    
    const settingsJson = JSON.stringify(settingsWithTimestamp);

    // Save to BOTH app metafield (private) AND shop metafield (public for Storefront API)
    const metafields = [
      // App metafield (private - for admin access)
      {
        ownerId: appInstallationId,
        namespace: "gwp_settings",
        key: "config",
        type: "json",
        value: settingsJson
      }
    ];
    
    // Also save to shop metafield if we have shop ID (public - for Storefront API access)
    if (shopId) {
      metafields.push({
        ownerId: shopId,
        namespace: "gwp",
        key: "config",
        type: "json",
        value: settingsJson
      });
    }

    console.log('Saving to', metafields.length, 'metafields');

    const response = await admin.graphql(
      `#graphql
        mutation createMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              ownerType
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          metafields: metafields
        }
      }
    );

    const responseJson = await response.json();
    console.log('Metafield response:', JSON.stringify(responseJson, null, 2));
    
    if (responseJson.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Error saving GWP settings:', responseJson.data.metafieldsSet.userErrors);
      throw new Error(`Failed to save settings: ${responseJson.data.metafieldsSet.userErrors.map(e => e.message).join(', ')}`);
    }
    
    console.log('Settings saved successfully to both app and shop metafields');
    return settings;
  } catch (error) {
    console.error('Error saving GWP settings:', error);
    throw error;
  }
}

/**
 * Lightweight helper to flip the isActive flag in the GWP metafield without
 * re-resolving products or running the full saveGWPSettings pipeline.
 */
export async function setGWPIsActive(admin, isActive) {
  try {
    const [appRes, settingsRes] = await Promise.all([
      admin.graphql(`query { currentAppInstallation { id } shop { id } }`),
      admin.graphql(
        `#graphql
          query {
            currentAppInstallation {
              metafield(namespace: "gwp_settings", key: "config") { value }
            }
          }`
      ),
    ]);
    const appData = await appRes.json();
    const settingsData = await settingsRes.json();

    const appInstallationId = appData.data?.currentAppInstallation?.id;
    const shopId = appData.data?.shop?.id;
    if (!appInstallationId) return;

    const raw = settingsData.data?.currentAppInstallation?.metafield?.value;
    if (!raw) return;

    const updated = { ...JSON.parse(raw), isActive };
    const value = JSON.stringify(updated);

    const metafields = [
      { ownerId: appInstallationId, namespace: "gwp_settings", key: "config", type: "json", value },
    ];
    if (shopId) {
      metafields.push({ ownerId: shopId, namespace: "gwp", key: "config", type: "json", value });
    }

    await admin.graphql(
      `mutation m($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
      { variables: { m: metafields } }
    );
  } catch (err) {
    console.error("setGWPIsActive failed:", err);
  }
}

/**
 * Recompute whether the storefront should treat GWP as active, based on the
 * LIVE status of the store's GWP discounts, and write the result everywhere the
 * progress bar reads it: the app metafield + shop metafield (read by the theme
 * Liquid) and the cache file (read by the public settings endpoint).
 *
 * "GWP is active" === at least one GWP discount currently has status ACTIVE.
 * A discount is GWP if it runs on the GWP function (title contains gwp/gift) or
 * its own title says "gwp" (catches legacy / mis-pointed discounts). Keep this
 * predicate in sync with app.gwp-config._index.jsx and the save action.
 *
 * Call this whenever discount status may have changed (save, app load, and the
 * discounts/* webhooks). Returns the computed isActive, or null on error.
 */
export async function syncGWPActiveState(admin, shop) {
  try {
    const fnRes = await admin.graphql(
      `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
    );
    const fnData = await fnRes.json();
    const gwpFunctionIds = new Set(
      (fnData.data?.shopifyFunctions?.nodes ?? [])
        .filter(
          (f) =>
            f.apiType === "discount" &&
            (f.title?.toLowerCase().includes("gwp") ||
              f.title?.toLowerCase().includes("gift"))
        )
        .map((f) => f.id)
    );

    // Filter SERVER-SIDE to active app-discounts only. Without the filter,
    // stores with many code-based discounts (hundreds of influencer/referral
    // codes etc.) fill the first 250 nodes with DiscountCodeBasic entries and
    // the GWP DiscountAutomaticApp lives on a later page that we never fetch,
    // making syncGWPActiveState incorrectly conclude no active GWP exists and
    // overwrite isActive=false on every run.
    //
    // The query string `status:active type:automatic_app` narrows the result
    // to exactly the discount type that drives GWP. Pagination is added as a
    // safety net in case a store ever has > 250 active automatic-app discounts,
    // which is unrealistic but cheap to handle.
    const nodes = [];
    let cursor = null;
    while (true) {
      const listRes = await admin.graphql(
        `query Discounts($cursor: String) {
          discountNodes(first: 250, after: $cursor, query: "status:active type:automatic_app") {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              discount {
                ... on DiscountAutomaticApp {
                  title
                  status
                  appDiscountType { functionId }
                }
              }
            }
          }
        }`,
        { variables: { cursor } }
      );
      const listData = await listRes.json();
      const page = listData.data?.discountNodes;
      if (!page) break;
      nodes.push(...(page.nodes ?? []));
      if (!page.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    const hasActive = nodes.some((n) => {
      const d = n?.discount;
      if (!d) return false;
      const fnId = d.appDiscountType?.functionId;
      const isGwp =
        (fnId && gwpFunctionIds.has(fnId)) ||
        d.title?.toLowerCase().includes("gwp");
      return isGwp && d.status === "ACTIVE";
    });

    // Write to the app + shop metafields (read by the theme Liquid).
    await setGWPIsActive(admin, hasActive);

    // Best-effort: keep the cache file (read by the public endpoint) in sync.
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const shopSlug = (shop || "").replace(/[^a-zA-Z0-9]/g, "-");
      if (shopSlug) {
        const configPath = path.join("./cache", `gwp-config-${shopSlug}.json`);
        const raw = await fs.readFile(configPath, "utf-8").catch(() => null);
        if (raw) {
          const cfg = JSON.parse(raw);
          cfg.isActive = hasActive;
          await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
        }
      }
    } catch (cacheErr) {
      console.log(
        "syncGWPActiveState cache write skipped (non-fatal):",
        cacheErr.message
      );
    }

    return hasActive;
  } catch (err) {
    console.error("syncGWPActiveState failed:", err);
    return null;
  }
}

/**
 * Enforce the "only one live GWP discount" rule. Deactivates every GWP discount
 * except the one being kept (ACTIVE → deactivate, SCHEDULED → delete so it can't
 * activate later; EXPIRED is already off).
 *
 * Choosing which to keep:
 *   - `keepNodeId` given (app toggle / save flow): keep that discount — but only
 *     if it's itself a GWP discount, so activating a non-GWP discount never
 *     touches GWP discounts.
 *   - `keepNodeId` omitted (webhook, where the payload's id format isn't
 *     reliable): if 2+ GWP discounts are ACTIVE, keep the most-recently-updated
 *     one (the one just turned on in the native admin) and deactivate the rest.
 *     If 0 or 1 are active, there's nothing to enforce.
 *
 * Returns true if enforcement ran, false if it was a no-op.
 */
export async function enforceSingleActiveGWP(admin, keepNodeId = null) {
  try {
    const fnRes = await admin.graphql(
      `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
    );
    const fnData = await fnRes.json();
    const gwpFunctionIds = new Set(
      (fnData.data?.shopifyFunctions?.nodes ?? [])
        .filter(
          (f) =>
            f.apiType === "discount" &&
            (f.title?.toLowerCase().includes("gwp") ||
              f.title?.toLowerCase().includes("gift"))
        )
        .map((f) => f.id)
    );

    const listRes = await admin.graphql(
      `query {
        discountNodes(first: 250) {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                updatedAt
                appDiscountType { functionId }
              }
            }
          }
        }
      }`
    );
    const listData = await listRes.json();
    const nodes = listData.data?.discountNodes?.nodes ?? [];

    const isGwp = (d) => {
      if (!d) return false;
      const fnId = d.appDiscountType?.functionId;
      return (
        (fnId && gwpFunctionIds.has(fnId)) ||
        d.title?.toLowerCase().includes("gwp")
      );
    };

    const gwpNodes = nodes.filter((n) => isGwp(n.discount));
    if (gwpNodes.length === 0) return false;

    // Resolve which discount to keep active.
    let keepId = null;
    if (keepNodeId && gwpNodes.some((n) => n.id === keepNodeId)) {
      keepId = keepNodeId;
    } else if (!keepNodeId) {
      // Recency mode (webhook): only act when more than one GWP discount is
      // live; keep whichever was updated most recently.
      const active = gwpNodes.filter((n) => n.discount.status === "ACTIVE");
      if (active.length <= 1) return false;
      active.sort(
        (a, b) =>
          new Date(b.discount.updatedAt) - new Date(a.discount.updatedAt)
      );
      keepId = active[0].id;
    }
    if (!keepId) return false;

    for (const n of gwpNodes) {
      if (n.id === keepId) continue;
      const d = n.discount;
      if (d.status === "EXPIRED") continue; // already off
      try {
        if (d.status === "SCHEDULED") {
          await admin.graphql(
            `mutation ($id: ID!) {
              discountAutomaticDelete(id: $id) {
                deletedAutomaticDiscountId
                userErrors { field message }
              }
            }`,
            { variables: { id: n.id } }
          );
        } else {
          await admin.graphql(
            `mutation ($id: ID!) {
              discountAutomaticDeactivate(id: $id) {
                automaticDiscountNode { id }
                userErrors { field message }
              }
            }`,
            { variables: { id: n.id } }
          );
        }
      } catch (e) {
        console.error(
          `enforceSingleActiveGWP: failed to deactivate ${n.id}:`,
          e.message
        );
      }
    }
    return true;
  } catch (err) {
    console.error("enforceSingleActiveGWP failed:", err);
    return false;
  }
}