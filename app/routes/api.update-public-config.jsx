import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { saveGWPSettings } from "../lib/storage.server";

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    
    if (!session?.shop) {
      return json({ error: "No shop found" }, { status: 400 });
    }

    const body = await request.json();
    const { tiers, isActive } = body;

    if (!tiers || !Array.isArray(tiers)) {
      return json({ error: "Tiers configuration is required" }, { status: 400 });
    }

    // Save the GWP settings
    const settings = await saveGWPSettings(admin, session.shop, {
      tiers,
      isActive: isActive !== false
    });

    // Create/update the automatic discount using the function extension
    console.log('🎯 About to create/update automatic discount, isActive:', isActive);
    if (isActive !== false) {
      console.log('🎯 Calling createOrUpdateAutomaticDiscount...');
      await createOrUpdateAutomaticDiscount(admin, session.shop, tiers);
      console.log('🎯 Finished createOrUpdateAutomaticDiscount');
    } else {
      console.log('🎯 GWP disabled, calling deleteAutomaticDiscount...');
      // If GWP is disabled, delete the automatic discount
      await deleteAutomaticDiscount(admin);
      console.log('🎯 Finished deleteAutomaticDiscount');
    }

    return json({ 
      success: true, 
      message: "GWP settings saved and discount codes updated",
      settings 
    });

  } catch (error) {
    console.error('Error updating GWP settings:', error);
    return json({ error: "Failed to update settings" }, { status: 500 });
  }
};

// Create or update the automatic discount using the function extension
async function createOrUpdateAutomaticDiscount(admin, shop, tiers) {
  try {
    console.log('🎯 Creating/updating automatic discount for GWP function');
    console.log('🎯 Shop:', shop);
    
    // First, let's find and delete ANY existing GWP discounts from this app
    // Query ALL automatic discounts to ensure we catch all of them
    const existingDiscountsQuery = `
      query {
        discountNodes(first: 250) {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                appDiscountType {
                  functionId
                }
              }
            }
          }
        }
      }
    `;

    const existingDiscountsResponse = await admin.graphql(existingDiscountsQuery);
    const existingDiscountsData = await existingDiscountsResponse.json();
    
    console.log('🎯 Raw GraphQL response:', JSON.stringify(existingDiscountsData, null, 2));

    const allDiscounts = existingDiscountsData.data?.discountNodes?.nodes || [];
    console.log('🎯 Total discount nodes found:', allDiscounts.length);
    console.log('🎯 All discounts:', JSON.stringify(allDiscounts.map(node => ({
      nodeId: node.id,
      hasDiscount: !!node.discount,
      title: node.discount?.title,
      status: node.discount?.status,
      functionId: node.discount?.appDiscountType?.functionId,
      fullDiscount: node.discount
    })), null, 2));

    // Get the function ID first so we can match by it
    const functionQuery = `
      query {
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `;

    const functionResponse = await admin.graphql(functionQuery);
    const functionData = await functionResponse.json();
    
    // Look for our specific function by title
    let targetFunctionId = null;
    if (functionData.data?.shopifyFunctions?.nodes?.length > 0) {
      const gwpFunction = functionData.data.shopifyFunctions.nodes.find(node => 
        (node.title?.toLowerCase().includes('gwp') || 
         node.title?.toLowerCase().includes('discount') ||
         node.title?.toLowerCase().includes('cart')) &&
        node.apiType === 'discount'
      );
      targetFunctionId = gwpFunction?.id;
      console.log('🎯 Found target GWP function:', gwpFunction);
    }
    
    // Fallback to hardcoded ID if no function found
    if (!targetFunctionId) {
      targetFunctionId = "dba8b188-8a04-42ed-a0f8-e377732b79f4";
      console.log('🎯 Using hardcoded function ID:', targetFunctionId);
    }

    const deleteMutation = `
      mutation discountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors {
            field
            code
            message
          }
        }
      }
    `;

    let deletedCount = 0;
    console.log('🎯 Target function ID for matching:', targetFunctionId);
    
    // Try to delete ALL discount nodes that match our criteria
    // and handle errors gracefully (some might not be DiscountAutomaticApp types)
    for (const node of allDiscounts) {
      const discount = node?.discount;
      const discountId = node.id;
      
      // Only process DiscountAutomaticApp types (app-managed discounts)
      // If discount has appDiscountType field, it's a DiscountAutomaticApp
      const discountFunctionId = discount?.appDiscountType?.functionId;
      if (!discount || !discountFunctionId) {
        console.log(`🎯 Skipping node ${discountId} - not a DiscountAutomaticApp (no appDiscountType)`);
        continue;
      }
      
      // Try to get discount info if available
      const title = discount?.title?.toLowerCase() || '';
      const status = discount?.status;
      
      console.log(`🎯 Checking node ${discountId}:`, {
        hasDiscount: !!discount,
        title: discount?.title || 'Unknown',
        status: status || 'Unknown',
        functionId: discountFunctionId || 'Unknown',
        matchesFunctionId: discountFunctionId === targetFunctionId,
        matchesTitle: title.includes('gwp') || title.includes('gift') || title.includes('tiered discount')
      });
      
      // Delete if:
      // 1. Uses the same functionId as our target function
      // 2. OR title contains "GWP", "Gift", or "Tiered Discount" (case insensitive)
      const matchesFunctionId = discountFunctionId === targetFunctionId;
      const matchesTitle = title.includes('gwp') || title.includes('gift') || title.includes('tiered discount');
      const shouldTryDelete = matchesFunctionId || matchesTitle;
      
      if (shouldTryDelete) {
        console.log(`🎯 Attempting to delete discount node ${discountId} (Title: ${discount?.title || 'Unknown'}, Status: ${status || 'Unknown'})`);
        
        try {
          const deleteResponse = await admin.graphql(deleteMutation, {
            variables: {
              id: discountId
            }
          });
          
          const deleteData = await deleteResponse.json();
          
          if (deleteData.data?.discountAutomaticDelete?.userErrors?.length > 0) {
            const errors = deleteData.data.discountAutomaticDelete.userErrors;
            console.error(`🎯 Error deleting node ${discountId}:`, errors);
            // Don't count as deleted if there were errors
          } else if (deleteData.data?.discountAutomaticDelete?.deletedAutomaticDiscountId) {
            console.log(`🎯 Successfully deleted discount: ${discount?.title || discountId}`);
            deletedCount++;
          } else {
            console.log(`🎯 Delete response for ${discountId}:`, deleteData);
          }
        } catch (error) {
          console.error(`🎯 Exception deleting node ${discountId}:`, error.message);
          // Continue - this might not be a DiscountAutomaticApp type
        }
      }
    }

    console.log(`🎯 Deleted ${deletedCount} existing GWP discount(s)`);
    
    // Wait a moment for deletion to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Now create the new GWP discount
    // Use the function ID we already found earlier
    const functionId = targetFunctionId;

    if (!functionId) {
      throw new Error("GWP discount function not found");
    }

    const createMutation = `
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Convert tiers to metafield format
    const tiersConfig = tiers.map((tier, index) => ({
      id: tier.id,
      name: tier.name,
      thresholdAmount: tier.thresholdAmount,
      tag: tier.tag || `tier${index + 1}-gift`,
      maxSelections: tier.maxSelections || 1
    }));

    console.log('🎯 Creating discount with function ID:', functionId);
    console.log('🎯 Tiers configuration:', tiersConfig);

    const createResponse = await admin.graphql(createMutation, {
      variables: {
        automaticAppDiscount: {
          title: "GWP Tiered Discount",
          functionId: functionId,
          discountClasses: ["PRODUCT"],
          startsAt: new Date().toISOString(),
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: true,
            shippingDiscounts: true
          },
          metafields: [
            {
              namespace: "gwp",
              key: "tiers",
              type: "json",
              value: JSON.stringify(tiersConfig)
            }
          ]
        }
      }
    });

    const createData = await createResponse.json();

    if (createData.data.discountAutomaticAppCreate.userErrors.length > 0) {
      throw new Error(`Failed to create discount: ${createData.data.discountAutomaticAppCreate.userErrors[0].message}`);
    }

    console.log("Successfully created GWP discount:", createData.data.discountAutomaticAppCreate.automaticAppDiscount);
  } catch (error) {
    console.error('Error creating/updating automatic discount:', error);
    throw error;
  }
}

// Delete the automatic discount
async function deleteAutomaticDiscount(admin) {
  try {
    console.log('🎯 Deleting automatic discount for GWP function');
    
    // Get the function ID first so we can match by it
    const functionQuery = `
      query {
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `;

    const functionResponse = await admin.graphql(functionQuery);
    const functionData = await functionResponse.json();
    
    // Look for our specific function by title
    let targetFunctionId = null;
    if (functionData.data?.shopifyFunctions?.nodes?.length > 0) {
      const gwpFunction = functionData.data.shopifyFunctions.nodes.find(node => 
        (node.title?.toLowerCase().includes('gwp') || 
         node.title?.toLowerCase().includes('discount') ||
         node.title?.toLowerCase().includes('cart')) &&
        node.apiType === 'discount'
      );
      targetFunctionId = gwpFunction?.id;
      console.log('🎯 Found target GWP function:', gwpFunction);
    }
    
    // Fallback to hardcoded ID if no function found
    if (!targetFunctionId) {
      targetFunctionId = "dba8b188-8a04-42ed-a0f8-e377732b79f4";
      console.log('🎯 Using hardcoded function ID:', targetFunctionId);
    }
    
    // Find ALL existing GWP discounts
    const existingDiscountsQuery = `
      query {
        discountNodes(first: 250) {
          nodes {
            __typename
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                appDiscountType {
                  functionId
                }
              }
            }
          }
        }
      }
    `;

    const existingDiscountsResponse = await admin.graphql(existingDiscountsQuery);
    const existingDiscountsData = await existingDiscountsResponse.json();

    const allDiscounts = existingDiscountsData.data?.discountNodes?.nodes || [];
    console.log('🎯 Total discount nodes found:', allDiscounts.length);
    console.log('🎯 All discounts:', JSON.stringify(allDiscounts.map(node => ({
      type: node.__typename,
      nodeId: node.id,
      hasDiscount: !!node.discount,
      title: node.discount?.title,
      status: node.discount?.status,
      functionId: node.discount?.appDiscountType?.functionId,
      fullDiscount: node.discount
    })), null, 2));

    const deleteMutation = `
      mutation discountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors {
            field
            code
            message
          }
        }
      }
    `;

    let deletedCount = 0;
    console.log('🎯 Target function ID for matching:', targetFunctionId);
    
    // Delete existing GWP discounts
    for (const node of allDiscounts) {
      const discount = node?.discount;
      if (!discount) {
        console.log('🎯 Skipping node - no discount:', node.id);
        continue;
      }
      
      // Only process DiscountAutomaticApp types (app-managed discounts)
      // If discount has appDiscountType field, it's a DiscountAutomaticApp
      const discountFunctionId = discount?.appDiscountType?.functionId;
      if (!discountFunctionId) {
        console.log(`🎯 Skipping discount "${discount.title || 'Unknown'}" - not a DiscountAutomaticApp (no appDiscountType)`);
        continue;
      }
      
      // Delete if:
      // 1. Uses the same functionId as our target function
      // 2. OR title contains "GWP", "Gift", or "Tiered Discount" (case insensitive)
      const title = discount.title?.toLowerCase() || '';
      const matchesFunctionId = discountFunctionId === targetFunctionId;
      const matchesTitle = title.includes('gwp') || title.includes('gift') || title.includes('tiered discount');
      
      console.log(`🎯 Checking discount "${discount.title}":`, {
        title,
        discountFunctionId,
        targetFunctionId,
        matchesFunctionId,
        matchesTitle,
        shouldDelete: matchesFunctionId || matchesTitle
      });
      
      if (matchesFunctionId || matchesTitle) {
        // Use node.id (not discount.id) for deletion - this is the correct ID for the mutation
        const discountId = node.id;
        console.log(`🎯 Deleting existing discount: ${discount.title} (Node ID: ${discountId}, Function ID: ${discountFunctionId || 'N/A'})`);
        
        try {
          const deleteResponse = await admin.graphql(deleteMutation, {
            variables: {
              id: discountId
            }
          });
          
          const deleteData = await deleteResponse.json();
          
          if (deleteData.data?.discountAutomaticDelete?.userErrors?.length > 0) {
            console.error(`🎯 Error deleting discount ${discount.title}:`, deleteData.data.discountAutomaticDelete.userErrors);
          } else if (deleteData.data?.discountAutomaticDelete?.deletedAutomaticDiscountId) {
            console.log(`🎯 Successfully deleted discount: ${discount.title}`);
            deletedCount++;
          } else {
            console.log(`🎯 Delete response for ${discount.title}:`, deleteData);
          }
        } catch (error) {
          console.error(`🎯 Exception deleting discount ${discount.title}:`, error);
        }
      }
    }

    console.log(`🎯 Deleted ${deletedCount} existing GWP discount(s)`);
  } catch (error) {
    console.error('Error deleting automatic discount:', error);
    throw error;
  }
}

// Create or update discount codes for each tier (legacy - keeping for reference)
async function createOrUpdateDiscountCodes(admin, tiers) {
  try {
    console.log('Creating/updating discount codes for tiers:', tiers);

    for (const tier of tiers) {
      const discountCode = `FREE ${tier.name.toUpperCase()} TIER GIFT!`;
      const discountCodeClean = discountCode.replace(/\s+/g, '').toUpperCase();

      // Check if discount code already exists
      const existingDiscountResponse = await admin.graphql(
        `#graphql
          query getDiscountCodes($query: String!) {
            codeDiscountNodes(first: 1, query: $query) {
              nodes {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    title
                    codes(first: 1) {
                      nodes {
                        code
                      }
                    }
                  }
                }
              }
            }
          }`,
        {
          variables: {
            query: `title:${discountCode}`
          }
        }
      );

      const existingDiscountData = await existingDiscountResponse.json();
      const existingDiscount = existingDiscountData.data?.codeDiscountNodes?.nodes?.[0];

      if (existingDiscount) {
        console.log(`Updating existing discount code: ${discountCode}`);
        await updateDiscountCode(admin, existingDiscount.id, tier, discountCode, discountCodeClean);
      } else {
        console.log(`Creating new discount code: ${discountCode}`);
        await createDiscountCode(admin, tier, discountCode, discountCodeClean);
      }
    }

    console.log('All discount codes created/updated successfully');
  } catch (error) {
    console.error('Error creating/updating discount codes:', error);
    throw error;
  }
}

// Create a new discount code
async function createDiscountCode(admin, tier, discountCode, discountCodeClean) {
  const response = await admin.graphql(
    `#graphql
      mutation createDiscountCode($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(input: $input) {
          codeDiscountNode {
            id
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
          title: discountCode,
          code: discountCodeClean,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year from now
          customerGets: {
            value: {
              percentage: 100.0
            },
            items: {
              all: true
            }
          },
          customerSelection: {
            all: true
          },
          usageLimit: 1000, // Allow multiple uses
          appliesOncePerCustomer: false,
          minimumRequirement: {
            subtotal: {
              greaterThanOrEqualToAmount: (tier.thresholdAmount / 100).toString()
            }
          }
        }
      }
    }
  );

  const responseData = await response.json();
  
  if (responseData.data?.discountCodeBasicCreate?.userErrors?.length > 0) {
    console.error('Error creating discount code:', responseData.data.discountCodeBasicCreate.userErrors);
    throw new Error(`Failed to create discount code: ${responseData.data.discountCodeBasicCreate.userErrors.map(e => e.message).join(', ')}`);
  }

  console.log(`Created discount code: ${discountCode}`);
}

// Update an existing discount code
async function updateDiscountCode(admin, discountId, tier, discountCode, discountCodeClean) {
  const response = await admin.graphql(
    `#graphql
      mutation updateDiscountCode($id: ID!, $input: DiscountCodeBasicInput!) {
        discountCodeBasicUpdate(id: $id, input: $input) {
          codeDiscountNode {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        id: discountId,
        input: {
          title: discountCode,
          code: discountCodeClean,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year from now
          customerGets: {
            value: {
              percentage: 100.0
            },
            items: {
              all: true
            }
          },
          customerSelection: {
            all: true
          },
          usageLimit: 1000, // Allow multiple uses
          appliesOncePerCustomer: false,
          minimumRequirement: {
            subtotal: {
              greaterThanOrEqualToAmount: (tier.thresholdAmount / 100).toString()
            }
          }
        }
      }
    }
  );

  const responseData = await response.json();
  
  if (responseData.data?.discountCodeBasicUpdate?.userErrors?.length > 0) {
    console.error('Error updating discount code:', responseData.data.discountCodeBasicUpdate.userErrors);
    throw new Error(`Failed to update discount code: ${responseData.data.discountCodeBasicUpdate.userErrors.map(e => e.message).join(', ')}`);
  }

  console.log(`Updated discount code: ${discountCode}`);
}

// Deactivate all GWP discount codes
async function deactivateGWPDiscountCodes(admin) {
  try {
    console.log('Deactivating all GWP discount codes');

    // Find all GWP discount codes
    const response = await admin.graphql(
      `#graphql
        query getGWPDiscountCodes {
          codeDiscountNodes(first: 50, query: "title:*TIER GIFT*") {
            nodes {
              id
              codeDiscount {
                ... on DiscountCodeBasic {
                  title
                }
              }
            }
          }
        }`
    );

    const responseData = await response.json();
    const gwpDiscounts = responseData.data?.codeDiscountNodes?.nodes || [];

    // Deactivate each GWP discount code
    for (const discount of gwpDiscounts) {
      if (discount.codeDiscount?.title?.includes('TIER GIFT')) {
        await admin.graphql(
          `#graphql
            mutation deactivateDiscountCode($id: ID!) {
              discountCodeDeactivate(id: $id) {
                userErrors {
                  field
                  message
                }
              }
            }`,
          {
            variables: {
              id: discount.id
            }
          }
        );
        console.log(`Deactivated discount code: ${discount.codeDiscount.title}`);
      }
    }

    console.log('All GWP discount codes deactivated');
  } catch (error) {
    console.error('Error deactivating GWP discount codes:', error);
    // Don't throw error here as it's not critical
  }
} 