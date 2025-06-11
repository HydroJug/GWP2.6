import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    
    console.log('Fetching real products from store:', session.shop);
    
    // Fetch products that would make good gifts (lower priced, available)
    const response = await admin.graphql(
      `#graphql
        query getGiftProducts {
          products(first: 20, query: "available_for_sale:true") {
            edges {
              node {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                variants(first: 5) {
                  edges {
                    node {
                      id
                      title
                      price
                      inventoryQuantity
                      availableForSale
                    }
                  }
                }
              }
            }
          }
        }`
    );

    const responseJson = await response.json();
    const products = responseJson.data?.products?.edges || [];
    
    console.log(`Found ${products.length} total products`);
    
    // Filter for products that would make good gifts
    const suitableGifts = products
      .map(edge => edge.node)
      .filter(product => {
        const firstVariant = product.variants.edges[0]?.node;
        if (!firstVariant) return false;
        
        const price = parseFloat(firstVariant.price);
        return (
          firstVariant.availableForSale &&
          price < 50 && // Under $50 for gifts
          (firstVariant.inventoryQuantity === null || firstVariant.inventoryQuantity > 0)
        );
      })
      .slice(0, 8); // Take first 8 suitable products

    console.log(`Found ${suitableGifts.length} suitable gift products`);
    
    // Convert to the format needed for the public API
    const giftProducts = suitableGifts.map(product => {
      const variant = product.variants.edges[0].node;
      // Extract numeric ID from GraphQL GID
      const variantId = variant.id.replace('gid://shopify/ProductVariant/', '');
      const productId = product.id.replace('gid://shopify/Product/', '');
      
      return {
        variantId,
        productId,
        title: product.title,
        image: product.featuredImage?.url || `https://via.placeholder.com/150x150/cccccc/666666?text=${encodeURIComponent(product.title)}`,
        price: "0.00", // Will be set to $0 by the cart transform
        originalPrice: variant.price
      };
    });

    // Split products into tiers
    const tier1Products = giftProducts.slice(0, 4);
    const tier2Products = giftProducts.slice(4, 8);

    const tiers = [
      {
        id: "free-gift-tier-1",
        name: "Silver",
        thresholdAmount: 8000, // $80
        description: "Free gift with $80+ purchase",
        maxSelections: 1,
        giftVariantIds: tier1Products.map(p => p.variantId),
        giftProducts: tier1Products
      }
    ];

    // Add second tier if we have enough products
    if (tier2Products.length > 0) {
      tiers.push({
        id: "free-gift-tier-2",
        name: "Gold",
        thresholdAmount: 12000, // $120
        description: "Additional free gift with $120+ purchase",
        maxSelections: 1,
        giftVariantIds: tier2Products.map(p => p.variantId),
        giftProducts: tier2Products
      });
    }

    // Save this configuration to a local file for the public API to use
    const fs = await import('fs/promises');
    const configPath = './real-products-config.json';
    
    const config = {
      tiers,
      lastUpdated: new Date().toISOString(),
      shop: session.shop
    };
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    
    console.log('Real products configuration saved to:', configPath);

    return json({
      success: true,
      message: `Found and configured ${giftProducts.length} real gift products`,
      tiers,
      products: giftProducts
    });

  } catch (error) {
    console.error('Error fetching real products:', error);
    return json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}; 