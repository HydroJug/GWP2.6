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
      await createOrUpdateAutomaticDiscount(admin, session.shop);
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
async function createOrUpdateAutomaticDiscount(admin, shop) {
  try {
    console.log('🎯 Creating/updating automatic discount for GWP function');
    console.log('🎯 Shop:', shop);
    
    // First, let's find and delete any existing GWP discounts from this app
    const existingDiscountsQuery = `
      query {
        automaticDiscountNodes(first: 10, query: "title:*GWP* OR title:*Gift*") {
          nodes {
            id
            automaticDiscount {
              ... on DiscountAutomaticApp {
                id
                title
                functionId
              }
            }
          }
        }
      }
    `;

    const existingDiscountsResponse = await admin.graphql(existingDiscountsQuery);
    const existingDiscountsData = await existingDiscountsResponse.json();

    // Delete existing GWP discounts
    for (const node of existingDiscountsData.data.automaticDiscountNodes.nodes) {
      if (node.automaticDiscount && node.automaticDiscount.title.includes('GWP')) {
        const deleteMutation = `
          mutation discountAutomaticAppDelete($id: ID!) {
            discountAutomaticAppDelete(input: { id: $id }) {
              deletedAutomaticAppDiscountId
              userErrors {
                field
                message
              }
            }
          }
        `;

        await admin.graphql(deleteMutation, {
          variables: {
            id: node.automaticDiscount.id
          }
        });

        console.log(`Deleted existing discount: ${node.automaticDiscount.title}`);
      }
    }

    // Now create the new GWP discount
    const createMutation = `
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            id
            title
            functionId
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

    // Get the function ID from the extension
    const functionQuery = `
      query {
        shopifyFunctions(first: 10, query: "title:*gwp-discount*") {
          nodes {
            id
            title
          }
        }
      }
    `;

    const functionResponse = await admin.graphql(functionQuery);
    const functionData = await functionResponse.json();
    
    let functionId = null;
    if (functionData.data.shopifyFunctions.nodes.length > 0) {
      functionId = functionData.data.shopifyFunctions.nodes[0].id;
    }

    if (!functionId) {
      throw new Error("GWP discount function not found");
    }

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
          }
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
    console.log('Deleting automatic discount for GWP function');
    
    // Find existing GWP discounts
    const existingDiscountsQuery = `
      query {
        automaticDiscountNodes(first: 10, query: "title:*GWP* OR title:*Gift*") {
          nodes {
            id
            automaticDiscount {
              ... on DiscountAutomaticApp {
                id
                title
              }
            }
          }
        }
      }
    `;

    const existingDiscountsResponse = await admin.graphql(existingDiscountsQuery);
    const existingDiscountsData = await existingDiscountsResponse.json();

    // Delete existing GWP discounts
    for (const node of existingDiscountsData.data.automaticDiscountNodes.nodes) {
      if (node.automaticDiscount && node.automaticDiscount.title.includes('GWP')) {
        const deleteMutation = `
          mutation discountAutomaticAppDelete($id: ID!) {
            discountAutomaticAppDelete(input: { id: $id }) {
              deletedAutomaticAppDiscountId
              userErrors {
                field
                message
              }
            }
          }
        `;

        await admin.graphql(deleteMutation, {
          variables: {
            id: node.automaticDiscount.id
          }
        });

        console.log(`Deleted existing discount: ${node.automaticDiscount.title}`);
      }
    }
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