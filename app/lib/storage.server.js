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
      console.error('No token returned from storefrontAccessTokenCreate');
      return null;
    }
    
    // Store the token in app metafield for future use
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
              value: newToken
            }]
          }
        }
      );
      console.log('Storefront Access Token created and stored');
    }
    
    return newToken;
    
  } catch (error) {
    console.error('Error getting/creating Storefront token:', error);
    return null;
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