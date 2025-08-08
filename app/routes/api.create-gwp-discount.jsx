import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
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

    return json({
      success: true,
      discount: createData.data.discountAutomaticAppCreate.automaticAppDiscount
    });

  } catch (error) {
    console.error("Error creating GWP discount:", error);
    return json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}; 