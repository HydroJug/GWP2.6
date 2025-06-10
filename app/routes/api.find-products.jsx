import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    
    // Fetch the specific Black Can Cooler product
    const response = await admin.graphql(
      `#graphql
        query getSpecificProduct($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            status
            featuredImage {
              url
              altText
            }
            images(first: 5) {
              edges {
                node {
                  id
                  url
                  altText
                }
              }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                  availableForSale
                  image {
                    url
                    altText
                  }
                }
              }
            }
          }
        }`,
      {
        variables: {
          id: "gid://shopify/Product/7873478066233" // Black Can Cooler product ID
        }
      }
    );

    const data = await response.json();
    
    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return json({ error: 'Failed to fetch product data', details: data.errors }, { status: 500 });
    }

    return json({
      product: data.data.product,
      message: "Product data fetched successfully"
    });

  } catch (error) {
    console.error('Error fetching product:', error);
    return json({ error: 'Failed to fetch product data', details: error.message }, { status: 500 });
  }
};

export const action = async ({ request }) => {
  return json({ error: "Method not allowed" }, { status: 405 });
}; 