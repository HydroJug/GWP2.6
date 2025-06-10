import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const configData = formData.get("config");
    
    if (!configData) {
      return json({ success: false, error: "No config data provided" }, { status: 400 });
    }
    
    const config = JSON.parse(configData);
    
    // For now, we'll store this in a simple way that the public API can access
    // In a real production app, you'd want to use a database or external storage
    
    // Create a simple storage mechanism using environment variables or external storage
    // For this demo, we'll use the same metafield approach but make it publicly readable
    
    console.log('Updating public configuration for shop:', session.shop);
    console.log('Config:', config);
    
    // Save to a public metafield that can be read without authentication
    const response = await admin.graphql(
      `#graphql
        mutation createPublicMetafield($metafields: [MetafieldsSetInput!]!) {
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
          metafields: [{
            ownerId: `gid://shopify/Shop/${session.shop.replace('.myshopify.com', '')}`,
            namespace: "gwp_public",
            key: "config",
            type: "json",
            value: JSON.stringify(config)
          }]
        }
      }
    );

    const responseJson = await response.json();
    
    if (responseJson.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Error saving public config:', responseJson.data.metafieldsSet.userErrors);
      return json({ 
        success: false, 
        error: responseJson.data.metafieldsSet.userErrors.map(e => e.message).join(', ')
      }, { status: 500 });
    }
    
    return json({ 
      success: true, 
      message: "Public configuration updated successfully"
    });
    
  } catch (error) {
    console.error('Error updating public config:', error);
    return json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}; 