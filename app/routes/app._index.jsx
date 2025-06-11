import { useState, useEffect, useCallback } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  TextField,
  ResourceList,
  ResourceItem,
  Thumbnail,
  InlineStack,
  Badge,
  EmptyState,
  Banner,
  Spinner,
  Box,
  Select,
  Divider,
  ButtonGroup,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import { getGWPSettings, saveGWPSettings } from "../lib/storage.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  // Get app settings from metafields
  const settings = await getGWPSettings(admin, session.shop);

  // Fetch gift product details for all tiers
  let allGiftProducts = [];
  const allProductIds = [];
  
  // Collect all product IDs from all tiers
  settings.tiers?.forEach(tier => {
    const productIds = Array.isArray(tier.giftProductIds) 
      ? tier.giftProductIds
      : (tier.giftProductIds ? tier.giftProductIds.split(',').filter(id => id.trim()) : []);
    allProductIds.push(...productIds);
  });
  
  // Remove duplicates
  const uniqueProductIds = [...new Set(allProductIds)];
  
  if (uniqueProductIds.length > 0) {
    try {
      const productQueries = uniqueProductIds.map(id => `id:${id}`).join(' OR ');
      const response = await admin.graphql(
        `#graphql
          query getGiftProducts($query: String!) {
            products(first: 50, query: $query) {
              edges {
                node {
                  id
                  title
                  handle
                  status
                  featuredImage {
                    url
                    altText
                  }
                  variants(first: 1) {
                    edges {
                      node {
                        id
                        price
                      }
                    }
                  }
                }
              }
            }
          }`,
        {
          variables: { query: productQueries },
        }
      );
      
      const responseJson = await response.json();
      allGiftProducts = responseJson.data.products.edges.map(edge => edge.node);
    } catch (error) {
      console.error('Error fetching gift products:', error);
    }
  }

  // Map products to tiers
  const tiersWithProducts = settings.tiers?.map(tier => {
    const productIds = Array.isArray(tier.giftProductIds) 
      ? tier.giftProductIds
      : (tier.giftProductIds ? tier.giftProductIds.split(',').filter(id => id.trim()) : []);
    
    const tierProducts = allGiftProducts.filter(product => 
      productIds.includes(product.id.replace("gid://shopify/Product/", ""))
    );
    
    return {
      ...tier,
      giftProductIds: productIds,
      giftProducts: tierProducts
    };
  }) || [];

  return json({ 
    settings: {
      tiers: tiersWithProducts,
      isActive: settings.isActive
    }
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  if (action === "searchProducts") {
    const query = formData.get("query");
    const response = await admin.graphql(
      `#graphql
        query searchProducts($query: String!) {
          products(first: 10, query: $query) {
            edges {
              node {
                id
                title
                handle
                status
                featuredImage {
                  url
                  altText
                }
                variants(first: 1) {
                  edges {
                    node {
                      id
                      price
                    }
                  }
                }
              }
            }
          }
        }`,
      {
        variables: { query },
      }
    );
    
    const responseJson = await response.json();
    return json({ 
      products: responseJson.data.products.edges.map(edge => edge.node),
      action: "searchProducts"
    });
  }

  if (action === "searchCollections") {
    const query = formData.get("query");
    
    try {
      console.log('Searching collections with query:', query);
      
      const response = await admin.graphql(
        `#graphql
          query searchCollections($query: String!) {
            collections(first: 10, query: $query) {
              edges {
                node {
                  id
                  title
                  handle
                  description
                  image {
                    url
                    altText
                  }
                  productsCount {
                    count
                  }
                  products(first: 5) {
                    edges {
                      node {
                        id
                        title
                        status
                        variants(first: 1) {
                          edges {
                            node {
                              id
                              availableForSale
                              inventoryQuantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
        {
          variables: { query },
        }
      );
      
      const responseJson = await response.json();
      console.log('Collections search response:', responseJson);
      
      if (responseJson.errors) {
        console.error('GraphQL errors in collections search:', responseJson.errors);
        return json({ 
          collections: [],
          action: "searchCollections",
          error: "Failed to search collections: " + responseJson.errors.map(e => e.message).join(', ')
        });
      }
      
      const collections = responseJson.data?.collections?.edges?.map(edge => {
        const collection = edge.node;
        
        // Count available products (not sold out)
        const availableProducts = collection.products.edges.filter(productEdge => {
          const product = productEdge.node;
          const firstVariant = product.variants.edges[0]?.node;
          return product.status === 'ACTIVE' && 
                 firstVariant && 
                 firstVariant.availableForSale && 
                 (firstVariant.inventoryQuantity === null || firstVariant.inventoryQuantity > 0);
        });
        
        return {
          ...collection,
          productsCount: collection.productsCount.count,
          availableProductsCount: availableProducts.length
        };
      }) || [];
      
      console.log('Found collections:', collections.length);
      
      return json({ 
        collections: collections,
        action: "searchCollections"
      });
    } catch (error) {
      console.error('Error searching collections:', error);
      return json({ 
        collections: [],
        action: "searchCollections",
        error: "Failed to search collections: " + error.message
      });
    }
  }

  if (action === "saveSettings") {
    const tiersData = formData.get("tiers");
    
    console.log('Saving multi-tier settings:', { tiersData });
    
    try {
      const tiers = JSON.parse(tiersData);
      
      // Save to metafields
      await saveGWPSettings(admin, session.shop, {
        tiers: tiers,
        isActive: true
      });
      
      // Also save a cached configuration for the public API
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        
        // Create cache directory if it doesn't exist
        const cacheDir = './cache';
        try {
          await fs.mkdir(cacheDir, { recursive: true });
        } catch (mkdirError) {
          // Directory might already exist
        }
        
        // Create cached config with collection-based tiers
        const cachedConfig = {
          tiers: tiers.map(tier => ({
            id: tier.id,
            name: tier.name,
            thresholdAmount: tier.thresholdAmount,
            description: tier.description,
            maxSelections: tier.maxSelections,
            // Include collection info if available
            collectionId: tier.collectionId,
            collectionHandle: tier.collectionHandle,
            collectionTitle: tier.collectionTitle,
            // Keep product-based approach as fallback
            giftVariantIds: tier.giftVariantIds || [],
            giftProducts: tier.giftProducts || []
          })),
          isActive: true
        };

        // Save shop-specific cached config
        const shopFileName = session.shop.replace(/[^a-zA-Z0-9]/g, '-');
        const configPath = path.join(cacheDir, `gwp-config-${shopFileName}.json`);
        
        await fs.writeFile(configPath, JSON.stringify(cachedConfig, null, 2));
        console.log(`Cached config saved to: ${configPath}`);
        
      } catch (cacheError) {
        console.error('Error saving cached config:', cacheError);
      }
      
      return json({ 
        success: true, 
        message: "Multi-tier settings saved successfully!",
        action: "saveSettings"
      });
    } catch (error) {
      console.error('Error saving settings:', error);
      return json({ 
        success: false, 
        error: error.message,
        action: "saveSettings"
      });
    }
  }

  return json({ error: "Invalid action" }, { status: 400 });
};

export default function Index() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  
  const [tiers, setTiers] = useState(settings.tiers || []);
  const [searchQuery, setSearchQuery] = useState("");
  const [collectionSearchQuery, setCollectionSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [collectionSearchResults, setCollectionSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchingCollections, setIsSearchingCollections] = useState(false);
  const [activeTierIndex, setActiveTierIndex] = useState(null);
  const [selectionMode, setSelectionMode] = useState("collection"); // "collection" or "products"

  const isLoading = ["loading", "submitting"].includes(fetcher.state);

  // Handle search results
  useEffect(() => {
    if (fetcher.data?.action === "searchProducts") {
      setSearchResults(fetcher.data.products || []);
      setIsSearching(false);
    }
    if (fetcher.data?.action === "searchCollections") {
      setCollectionSearchResults(fetcher.data.collections || []);
      setIsSearchingCollections(false);
      
      // Show error if collection search failed
      if (fetcher.data.error) {
        shopify.toast.show(`Collection search error: ${fetcher.data.error}`, { isError: true });
      }
    }
    if (fetcher.data?.action === "saveSettings") {
      if (fetcher.data.success) {
        shopify.toast.show(fetcher.data.message);
      } else {
        shopify.toast.show(`Error: ${fetcher.data.error}`, { isError: true });
      }
    }
  }, [fetcher.data, shopify]);

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      setIsSearching(true);
      fetcher.submit(
        { action: "searchProducts", query: searchQuery },
        { method: "POST" }
      );
    }
  }, [searchQuery, fetcher]);

  const handleCollectionSearch = useCallback(() => {
    if (collectionSearchQuery.trim()) {
      setIsSearchingCollections(true);
      fetcher.submit(
        { action: "searchCollections", query: collectionSearchQuery },
        { method: "POST" }
      );
    }
  }, [collectionSearchQuery, fetcher]);

  const handleAddTier = useCallback(() => {
    const newTier = {
      id: `tier${Date.now()}`,
              thresholdAmount: 12000, // $120 default
      name: `Tier ${tiers.length + 1}`,
      giftProductIds: [],
      giftProducts: [],
      maxSelections: 1,
      description: 'Choose 1 free gift',
      // Collection-based fields
      collectionId: null,
      collectionHandle: null,
      collectionTitle: null
    };
    setTiers([...tiers, newTier]);
  }, [tiers]);

  const handleRemoveTier = useCallback((tierIndex) => {
    setTiers(tiers.filter((_, index) => index !== tierIndex));
  }, [tiers]);

  const handleUpdateTier = useCallback((tierIndex, updates) => {
    setTiers(tiers.map((tier, index) => 
      index === tierIndex ? { ...tier, ...updates } : tier
    ));
  }, [tiers]);

  const handleAddProductToTier = useCallback((tierIndex, product) => {
    const tier = tiers[tierIndex];
    if (!tier.giftProducts.find(p => p.id === product.id)) {
      const updatedProducts = [...tier.giftProducts, product];
      const updatedProductIds = updatedProducts.map(p => p.id.replace("gid://shopify/Product/", ""));
      
      handleUpdateTier(tierIndex, {
        giftProducts: updatedProducts,
        giftProductIds: updatedProductIds
      });
      
      setSearchResults([]);
      setSearchQuery("");
      setActiveTierIndex(null);
    }
  }, [tiers, handleUpdateTier]);

  const handleAddCollectionToTier = useCallback((tierIndex, collection) => {
    const collectionId = collection.id.replace("gid://shopify/Collection/", "");
    
    handleUpdateTier(tierIndex, {
      collectionId: collectionId,
      collectionHandle: collection.handle,
      collectionTitle: collection.title,
      // Clear individual products when using collection
      giftProducts: [],
      giftProductIds: []
    });
    
    setCollectionSearchResults([]);
    setCollectionSearchQuery("");
    setActiveTierIndex(null);
  }, [handleUpdateTier]);

  const handleRemoveProductFromTier = useCallback((tierIndex, productId) => {
    const tier = tiers[tierIndex];
    const updatedProducts = tier.giftProducts.filter(p => p.id !== productId);
    const updatedProductIds = updatedProducts.map(p => p.id.replace("gid://shopify/Product/", ""));
    
    handleUpdateTier(tierIndex, {
      giftProducts: updatedProducts,
      giftProductIds: updatedProductIds
    });
  }, [tiers, handleUpdateTier]);

  const handleRemoveCollectionFromTier = useCallback((tierIndex) => {
    handleUpdateTier(tierIndex, {
      collectionId: null,
      collectionHandle: null,
      collectionTitle: null
    });
  }, [handleUpdateTier]);

  const handleSaveSettings = useCallback(() => {
    // Sort tiers by threshold amount
    const sortedTiers = [...tiers].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    
    fetcher.submit(
      { 
        action: "saveSettings", 
        tiers: JSON.stringify(sortedTiers)
      },
      { method: "POST" }
    );
  }, [tiers, fetcher]);

  const formatPrice = (amount) => {
    return `$${(parseInt(amount) / 100).toFixed(2)}`;
  };

  const maxSelectionOptions = [
    { label: '1 gift', value: '1' },
    { label: '2 gifts', value: '2' },
    { label: '3 gifts', value: '3' },
    { label: '4 gifts', value: '4' },
    { label: '5 gifts', value: '5' },
  ];

  return (
    <Page>
      <TitleBar title="Multi-Tier Gift with Purchase Settings" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">
                  Multi-Tier Gift with Purchase Configuration
                </Text>
                
                <Banner status="info">
                  <p>
                    Create multiple gift tiers with different threshold amounts. Customers unlock higher tiers as their cart value increases, 
                    and can select multiple gifts if configured. Tiers are automatically sorted by threshold amount.
                  </p>
                </Banner>

                <InlineStack align="space-between">
                  <Text as="h3" variant="headingMd">
                    Gift Tiers ({tiers.length})
                  </Text>
                  <Button onClick={handleAddTier} variant="primary">
                    Add New Tier
                  </Button>
                </InlineStack>

                {tiers.length === 0 ? (
                  <EmptyState
                    heading="No gift tiers configured"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Create your first gift tier to get started with multi-tier gift with purchase.</p>
                    <Button onClick={handleAddTier} variant="primary">
                      Create First Tier
                    </Button>
                  </EmptyState>
                ) : (
                  <BlockStack gap="400">
                    {tiers.map((tier, tierIndex) => (
                      <Card key={tier.id} sectioned>
                        <BlockStack gap="400">
                          <InlineStack align="space-between">
                            <Text as="h4" variant="headingMd">
                              {tier.name}
                            </Text>
                            <ButtonGroup>
                              <Button 
                                onClick={() => setActiveTierIndex(activeTierIndex === tierIndex ? null : tierIndex)}
                                variant={activeTierIndex === tierIndex ? "primary" : "secondary"}
                              >
                                {activeTierIndex === tierIndex ? "Close" : "Add Products"}
                              </Button>
                              <Button 
                                onClick={() => handleRemoveTier(tierIndex)}
                                variant="plain"
                                tone="critical"
                              >
                                Remove Tier
                              </Button>
                            </ButtonGroup>
                          </InlineStack>

                          <InlineStack gap="400">
                            <Box minWidth="200px">
                              <TextField
                                label="Tier Name"
                                value={tier.name}
                                onChange={(value) => handleUpdateTier(tierIndex, { name: value })}
                                placeholder="e.g., Bronze Tier"
                              />
                            </Box>
                            <Box minWidth="200px">
                              <TextField
                                label="Threshold (cents)"
                                type="number"
                                value={tier.thresholdAmount.toString()}
                                onChange={(value) => handleUpdateTier(tierIndex, { thresholdAmount: parseInt(value) || 0 })}
                                helpText={`${formatPrice(tier.thresholdAmount)}`}
                                placeholder="8000"
                              />
                            </Box>
                            <Box minWidth="150px">
                              <Select
                                label="Max Selections"
                                options={maxSelectionOptions}
                                value={tier.maxSelections.toString()}
                                onChange={(value) => handleUpdateTier(tierIndex, { maxSelections: parseInt(value) })}
                              />
                            </Box>
                          </InlineStack>

                          <TextField
                            label="Description"
                            value={tier.description}
                            onChange={(value) => handleUpdateTier(tierIndex, { description: value })}
                            placeholder="e.g., Choose 1 free gift"
                            helpText="This description will be shown to customers"
                          />

                          {/* Product Search for Active Tier */}
                          {activeTierIndex === tierIndex && (
                            <Card sectioned>
                              <BlockStack gap="300">
                                <InlineStack align="space-between">
                                  <Text as="h5" variant="headingSm">Configure {tier.name} Gifts</Text>
                                  <ButtonGroup segmented>
                                    <Button
                                      pressed={selectionMode === "collection"}
                                      onClick={() => setSelectionMode("collection")}
                                    >
                                      Use Collection
                                    </Button>
                                    <Button
                                      pressed={selectionMode === "products"}
                                      onClick={() => setSelectionMode("products")}
                                    >
                                      Individual Products
                                    </Button>
                                  </ButtonGroup>
                                </InlineStack>

                                {selectionMode === "collection" ? (
                                  <BlockStack gap="300">
                                    <Text variant="bodySm" color="subdued">
                                      Select a collection to automatically include all products from that collection as gift options.
                                    </Text>
                                    
                                    <InlineStack gap="300">
                                      <TextField
                                        label="Search collections"
                                        value={collectionSearchQuery}
                                        onChange={setCollectionSearchQuery}
                                        placeholder="Enter collection name..."
                                        onKeyPress={(e) => e.key === 'Enter' && handleCollectionSearch()}
                                      />
                                      <Box paddingBlockStart="600">
                                        <Button 
                                          onClick={handleCollectionSearch} 
                                          loading={isSearchingCollections}
                                          disabled={!collectionSearchQuery.trim()}
                                        >
                                          Search
                                        </Button>
                                      </Box>
                                    </InlineStack>

                                    {isSearchingCollections && (
                                      <Box padding="400">
                                        <InlineStack align="center" gap="200">
                                          <Spinner size="small" />
                                          <Text>Searching collections...</Text>
                                        </InlineStack>
                                      </Box>
                                    )}

                                    {collectionSearchResults.length > 0 && (
                                      <Card>
                                        <Text as="h6" variant="headingSm">Collection Search Results</Text>
                                        <ResourceList
                                          resourceName={{ singular: 'collection', plural: 'collections' }}
                                          items={collectionSearchResults}
                                          renderItem={(collection) => {
                                            const { id, title, handle, description, image, productsCount, availableProductsCount } = collection;
                                            const isSelected = tier.collectionId === id.replace("gid://shopify/Collection/", "");
                                            const hasAvailableProducts = availableProductsCount > 0;
                                            
                                            return (
                                              <ResourceItem
                                                id={id}
                                                media={
                                                  <Thumbnail
                                                    source={image?.url || ""}
                                                    alt={image?.altText || title}
                                                  />
                                                }
                                                accessibilityLabel={`View details for ${title}`}
                                              >
                                                <InlineStack align="space-between">
                                                  <BlockStack gap="100">
                                                    <Text variant="bodyMd" fontWeight="bold">
                                                      {title}
                                                    </Text>
                                                    <Text variant="bodySm" color="subdued">
                                                      {productsCount} total products • {availableProductsCount} available • Handle: {handle}
                                                    </Text>
                                                    {!hasAvailableProducts && (
                                                      <Text variant="bodySm" color="critical">
                                                        ⚠️ No products currently available for sale in this collection
                                                      </Text>
                                                    )}
                                                    {description && (
                                                      <Text variant="bodySm" color="subdued">
                                                        {description.substring(0, 100)}...
                                                      </Text>
                                                    )}
                                                  </BlockStack>
                                                  <Button
                                                    onClick={() => handleAddCollectionToTier(tierIndex, collection)}
                                                    disabled={isSelected || !hasAvailableProducts}
                                                    variant={isSelected ? "plain" : "primary"}
                                                  >
                                                    {isSelected ? "Selected" : hasAvailableProducts ? "Select" : "No Products Available"}
                                                  </Button>
                                                </InlineStack>
                                              </ResourceItem>
                                            );
                                          }}
                                        />
                                      </Card>
                                    )}
                                  </BlockStack>
                                ) : (
                                  <BlockStack gap="300">
                                    <Text variant="bodySm" color="subdued">
                                      Search and select individual products to include as gift options.
                                    </Text>
                                    
                                    <InlineStack gap="300">
                                      <TextField
                                        label="Search products"
                                        value={searchQuery}
                                        onChange={setSearchQuery}
                                        placeholder="Enter product name..."
                                        onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                                      />
                                      <Box paddingBlockStart="600">
                                        <Button 
                                          onClick={handleSearch} 
                                          loading={isSearching}
                                          disabled={!searchQuery.trim()}
                                        >
                                          Search
                                        </Button>
                                      </Box>
                                    </InlineStack>

                                    {isSearching && (
                                      <Box padding="400">
                                        <InlineStack align="center" gap="200">
                                          <Spinner size="small" />
                                          <Text>Searching products...</Text>
                                        </InlineStack>
                                      </Box>
                                    )}

                                    {searchResults.length > 0 && (
                                      <Card>
                                        <Text as="h6" variant="headingSm">Product Search Results</Text>
                                        <ResourceList
                                          resourceName={{ singular: 'product', plural: 'products' }}
                                          items={searchResults}
                                          renderItem={(product) => {
                                            const { id, title, featuredImage, variants, status } = product;
                                            const price = variants.edges[0]?.node.price || "0.00";
                                            const isSelected = tier.giftProducts.find(p => p.id === id);
                                            
                                            return (
                                              <ResourceItem
                                                id={id}
                                                media={
                                                  <Thumbnail
                                                    source={featuredImage?.url || ""}
                                                    alt={featuredImage?.altText || title}
                                                  />
                                                }
                                                accessibilityLabel={`View details for ${title}`}
                                              >
                                                <InlineStack align="space-between">
                                                  <BlockStack gap="100">
                                                    <Text variant="bodyMd" fontWeight="bold">
                                                      {title}
                                                    </Text>
                                                    <Text variant="bodySm" color="subdued">
                                                      ${price} • {status}
                                                    </Text>
                                                  </BlockStack>
                                                  <Button
                                                    onClick={() => handleAddProductToTier(tierIndex, product)}
                                                    disabled={isSelected}
                                                    variant={isSelected ? "plain" : "primary"}
                                                  >
                                                    {isSelected ? "Added" : "Add"}
                                                  </Button>
                                                </InlineStack>
                                              </ResourceItem>
                                            );
                                          }}
                                        />
                                      </Card>
                                    )}
                                  </BlockStack>
                                )}
                              </BlockStack>
                            </Card>
                          )}

                          {/* Display Selected Collection or Products */}
                          {tier.collectionId ? (
                            <Card>
                              <BlockStack gap="300">
                                <Text as="h5" variant="headingSm">
                                  Selected Collection for {tier.name}
                                </Text>
                                <InlineStack align="space-between">
                                  <BlockStack gap="100">
                                    <Text variant="bodyMd" fontWeight="bold">
                                      {tier.collectionTitle}
                                    </Text>
                                    <Text variant="bodySm" color="subdued">
                                      Handle: {tier.collectionHandle}
                                    </Text>
                                    <Badge status="success">Collection-based gifts</Badge>
                                  </BlockStack>
                                  <Button
                                    onClick={() => handleRemoveCollectionFromTier(tierIndex)}
                                    variant="plain"
                                    tone="critical"
                                  >
                                    Remove Collection
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          ) : tier.giftProducts.length > 0 ? (
                            <Card>
                              <BlockStack gap="300">
                                <Text as="h5" variant="headingSm">
                                  Gift Products for {tier.name} ({tier.giftProducts.length})
                                </Text>
                                <ResourceList
                                  resourceName={{ singular: 'product', plural: 'products' }}
                                  items={tier.giftProducts}
                                  renderItem={(product) => {
                                    const { id, title, featuredImage, variants } = product;
                                    const price = variants.edges[0]?.node.price || "0.00";
                                    
                                    return (
                                      <ResourceItem
                                        id={id}
                                        media={
                                          <Thumbnail
                                            source={featuredImage?.url || ""}
                                            alt={featuredImage?.altText || title}
                                          />
                                        }
                                      >
                                        <InlineStack align="space-between">
                                          <BlockStack gap="100">
                                            <Text variant="bodyMd" fontWeight="bold">
                                              {title}
                                            </Text>
                                            <Text variant="bodySm" color="subdued">
                                              Original price: ${price}
                                            </Text>
                                            <Badge status="success">Gift Product</Badge>
                                          </BlockStack>
                                          <Button
                                            onClick={() => handleRemoveProductFromTier(tierIndex, id)}
                                            variant="plain"
                                            tone="critical"
                                          >
                                            Remove
                                          </Button>
                                        </InlineStack>
                                      </ResourceItem>
                                    );
                                  }}
                                />
                              </BlockStack>
                            </Card>
                          ) : (
                            <EmptyState
                              heading={`No gifts configured for ${tier.name}`}
                              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                            >
                              <p>Select a collection or add individual products that customers can choose as free gifts for this tier.</p>
                            </EmptyState>
                          )}
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                )}

                {tiers.length > 0 && (
                  <>
                    <Divider />
                    <InlineStack align="end">
                      <Button
                        variant="primary"
                        onClick={handleSaveSettings}
                        loading={isLoading}
                        disabled={tiers.length === 0 || tiers.some(tier => !tier.collectionId && tier.giftProducts.length === 0)}
                      >
                        Save Multi-Tier Settings
                      </Button>
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
