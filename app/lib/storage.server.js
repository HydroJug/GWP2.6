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
              thresholdAmount: 12000
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
      isActive: true
    };
  }
}

export async function saveGWPSettings(admin, shop, settings) {
  try {
    console.log('Starting saveGWPSettings with:', { shop, settings });
    
    // Get the current app installation ID
    const appResponse = await admin.graphql(
      `#graphql
        query {
          currentAppInstallation {
            id
          }
        }`
    );
    
    const appData = await appResponse.json();
    console.log('App installation response:', JSON.stringify(appData, null, 2));
    
    const appInstallationId = appData.data?.currentAppInstallation?.id;
    
    if (!appInstallationId) {
      console.error('No app installation ID found in response:', appData);
      throw new Error('Could not get app installation ID');
    }

    console.log('Using app installation ID:', appInstallationId);

    const metafieldInput = {
      ownerId: appInstallationId,
      namespace: "gwp_settings",
      key: "config",
      type: "json",
      value: JSON.stringify({
        ...settings,
        updatedAt: new Date().toISOString()
      })
    };

    console.log('Metafield input:', JSON.stringify(metafieldInput, null, 2));

    const response = await admin.graphql(
      `#graphql
        mutation createAppMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          metafields: [metafieldInput]
        }
      }
    );

    const responseJson = await response.json();
    console.log('Metafield response:', JSON.stringify(responseJson, null, 2));
    
    if (responseJson.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Error saving GWP settings:', responseJson.data.metafieldsSet.userErrors);
      throw new Error(`Failed to save settings: ${responseJson.data.metafieldsSet.userErrors.map(e => e.message).join(', ')}`);
    }
    
    console.log('Settings saved successfully');
    return settings;
  } catch (error) {
    console.error('Error saving GWP settings:', error);
    throw error;
  }
} 