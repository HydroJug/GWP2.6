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
      isActive: settings.isActive,
      progressBar: settings.progressBar || null
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
    const progressBarData = formData.get("progressBar");
    
    console.log('Saving multi-tier settings:', { tiersData, progressBarData });
    
    try {
      let tiers = JSON.parse(tiersData);
      const progressBar = progressBarData ? JSON.parse(progressBarData) : null;
      
      // For collection-based tiers, fetch ALL product IDs from the collection
      // This is the key fix: we store product IDs so the discount function can match by ID, not tags
      const tiersWithProducts = await Promise.all(tiers.map(async (tier) => {
        // If tier uses a collection, fetch all products from that collection
        if (tier.collectionId) {
          try {
            console.log(`Fetching products for collection: ${tier.collectionHandle} (ID: ${tier.collectionId})`);
            
            // Fetch all products from the collection (up to 250)
            const collectionResponse = await admin.graphql(
              `#graphql
                query getCollectionProducts($id: ID!) {
                  collection(id: $id) {
                    products(first: 250) {
                      edges {
                        node {
                          id
                          title
                          featuredImage {
                            url
                          }
                          variants(first: 1) {
                            edges {
                              node {
                                id
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }`,
              { variables: { id: `gid://shopify/Collection/${tier.collectionId}` } }
            );
            const collectionData = await collectionResponse.json();
            const products = collectionData.data?.collection?.products?.edges || [];
            
            // Extract product IDs (full GIDs like gid://shopify/Product/123)
            const productIds = products.map(edge => edge.node.id);
            const firstProduct = products[0]?.node;
            
            console.log(`Found ${productIds.length} products in collection ${tier.collectionHandle}`);
            console.log(`Product IDs: ${productIds.slice(0, 5).join(', ')}${productIds.length > 5 ? '...' : ''}`);
            
            return {
              ...tier,
              // Store the full product GIDs for the discount function
              collectionProductIds: productIds,
              collectionImageUrl: firstProduct?.featuredImage?.url || tier.collectionImageUrl
            };
          } catch (error) {
            console.error(`Error fetching collection products for tier ${tier.name}:`, error);
          }
        }
        return tier;
      }));
      
      const tiersWithImages = tiersWithProducts;
      
      tiers = tiersWithImages;
      
      // Save to metafields
      await saveGWPSettings(admin, session.shop, {
        tiers: tiers,
        progressBar: progressBar,
        isActive: true
      });
      
      // Also save to our config API for public access
      try {
        const baseUrl = process.env.SHOPIFY_APP_URL || 'https://gwp-2-6.vercel.app';
        // Admin save debug disabled
        // console.debug('Saving config to API for shop:', session.shop);
        // console.debug('Config data:', { tiers, progressBar, isActive: true });

        // Determine canonical storage key as the shop's primary domain host
        let primaryDomainHost = session.shop;
        try {
          const primaryResp = await admin.graphql(`{ shop { primaryDomain { host } } }`);
          const primaryData = await primaryResp.json();
          const host = primaryData?.data?.shop?.primaryDomain?.host;
          if (host) {
            primaryDomainHost = host;
          }
          // console.debug('Primary domain host resolved as:', primaryDomainHost);
        } catch (e) {
          console.error('Failed to fetch primary domain host, falling back to session.shop:', e);
        }

        // Build aliases so either domain works
        const aliases = Array.from(new Set([
          session.shop,
          primaryDomainHost,
          primaryDomainHost.startsWith('www.') ? primaryDomainHost.slice(4) : `www.${primaryDomainHost}`
        ]));
        // console.debug('Aliases to save with config:', aliases);
        
        const configResponse = await fetch(`${baseUrl}/app/gwp/config`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // Use primary domain as the canonical key so storefront calls using host hit directly
            shop: primaryDomainHost,
            config: {
              tiers: tiers,
              progressBar: progressBar,
              isActive: true
            },
            aliases
          })
        });
        
        if (configResponse.ok) {
          // console.debug('Configuration saved to public API');
          // const responseData = await configResponse.json();
          // console.debug('Config API response:', responseData);
        } else {
          console.error('Failed to save configuration to public API:', configResponse.status);
          const errorText = await configResponse.text();
          console.error('Error response:', errorText);
        }
      } catch (error) {
        console.error('Error saving configuration to public API:', error);
      }
      
      // Also save a cached configuration for the public API
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        
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
            collectionImageUrl: tier.collectionImageUrl,
            // Include product IDs for discount function
            collectionProductIds: tier.collectionProductIds || [],
            // Keep product-based approach as fallback
            giftVariantIds: tier.giftVariantIds || [],
            giftProducts: tier.giftProducts || []
          })),
          progressBar: progressBar,
          isActive: true
        };

        const shopFileName = session.shop.replace(/[^a-zA-Z0-9]/g, '-');
        const configFileName = `gwp-config-${shopFileName}.json`;
        const configContent = JSON.stringify(cachedConfig, null, 2);
        
        // Try to save to multiple cache directories for different environments
        // Vercel's writable filesystem is in /tmp, local dev uses ./cache
        const cacheDirs = ['./cache', '/tmp/cache'];
        
        for (const cacheDir of cacheDirs) {
          try {
            await fs.mkdir(cacheDir, { recursive: true });
            const configPath = path.join(cacheDir, configFileName);
            await fs.writeFile(configPath, configContent);
            console.log(`Cached config saved to: ${configPath}`);
          } catch (dirError) {
            console.log(`Could not save to ${cacheDir}:`, dirError.message);
          }
        }
        
      } catch (cacheError) {
        console.error('Error saving cached config:', cacheError);
      }



      // Create/update the automatic discount using the function extension
      console.log('🎯 About to create/update automatic discount');
      try {
        await createOrUpdateAutomaticDiscount(admin, session.shop, tiers);
        console.log('🎯 Successfully created/updated automatic discount');
      } catch (discountError) {
        console.error('🎯 Error creating automatic discount:', discountError);
        // Don't fail the entire save operation if discount creation fails
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
  const [progressBarConfig, setProgressBarConfig] = useState({
    enabled: settings.progressBar?.enabled ?? false,
    selector: settings.progressBar?.selector ?? '',
    position: settings.progressBar?.position ?? 'below',
    modalBehavior: settings.progressBar?.modalBehavior ?? 'auto',
    freeShipping: {
      enabled: settings.progressBar?.freeShipping?.enabled ?? false,
      threshold: settings.progressBar?.freeShipping?.threshold ?? 10000 // $100 default
    }
  });
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
      thresholdAmount: 7000, // $70 default
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
    setTiers(tiers.map((tier, index) => {
      if (index === tierIndex) {
        // Create updated tier with the provided updates
        const updatedTier = { ...tier, ...updates };
        return updatedTier;
      }
      return tier;
    }));
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
        tiers: JSON.stringify(sortedTiers),
        progressBar: JSON.stringify(progressBarConfig)
      },
      { method: "POST" }
    );
  }, [tiers, progressBarConfig, fetcher]);

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
                                helpText={`${formatPrice(tier.thresholdAmount)} - Cart total required to qualify for this tier`}
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
                    
                    {/* Progress Bar Configuration */}
                    <Card sectioned>
                      <BlockStack gap="400">
                        <Text as="h3" variant="headingMd">
                          Progress Bar Configuration
                        </Text>
                        
                        <Banner status="info">
                          <p>
                            Configure where the progress bar appears on your store. Enter a CSS selector to target a specific element, 
                            then choose whether to place the progress bar above or below that element.
                          </p>
                        </Banner>

                        <InlineStack gap="400" wrap>
                          <Box minWidth="200px">
                            <TextField
                              label="CSS Selector"
                              value={progressBarConfig.selector}
                              onChange={(value) => setProgressBarConfig(prev => ({ ...prev, selector: value }))}
                              placeholder="e.g., .cart__items, #cart, .product-form"
                              helpText="Target element where progress bar should appear"
                            />
                          </Box>
                          <Box minWidth="150px">
                            <Select
                              label="Position"
                              options={[
                                { label: 'Above', value: 'above' },
                                { label: 'Below', value: 'below' }
                              ]}
                              value={progressBarConfig.position}
                              onChange={(value) => setProgressBarConfig(prev => ({ ...prev, position: value }))}
                            />
                          </Box>
                          <Box minWidth="200px">
                            <Select
                              label="Modal Behavior"
                              options={[
                                { label: 'Auto-popup when threshold met', value: 'auto' },
                                { label: 'Only on progress bar click', value: 'click' }
                              ]}
                              value={progressBarConfig.modalBehavior || 'auto'}
                              onChange={(value) => setProgressBarConfig(prev => ({ ...prev, modalBehavior: value }))}
                              helpText="When should the gift modal appear?"
                            />
                          </Box>
                          <Box paddingBlockStart="600">
                            <Button
                              variant={progressBarConfig.enabled ? "primary" : "secondary"}
                              onClick={() => setProgressBarConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                            >
                              {progressBarConfig.enabled ? "Enabled" : "Disabled"}
                            </Button>
                          </Box>
                        </InlineStack>

                        {progressBarConfig.enabled && progressBarConfig.selector && (
                          <Banner status="success">
                            <p>
                              Progress bar will appear <strong>{progressBarConfig.position}</strong> the element: <code>{progressBarConfig.selector}</code>
                            </p>
                          </Banner>
                        )}

                        {progressBarConfig.enabled && !progressBarConfig.selector && (
                          <Banner status="warning">
                            <p>
                              Please enter a CSS selector to specify where the progress bar should appear.
                            </p>
                          </Banner>
                        )}

                        <Divider />
                        
                        <Text as="h4" variant="headingSm">
                          Free Shipping Indicator
                        </Text>
                        
                        <InlineStack gap="400" blockAlign="center">
                          <Box minWidth="200px">
                            <TextField
                              label="Free Shipping Threshold"
                              type="number"
                              value={String(progressBarConfig.freeShipping?.threshold / 100 || 100)}
                              onChange={(value) => setProgressBarConfig(prev => ({ 
                                ...prev, 
                                freeShipping: { 
                                  ...prev.freeShipping, 
                                  threshold: Math.round(parseFloat(value || 0) * 100) 
                                } 
                              }))}
                              prefix="$"
                              helpText="Cart total needed for free shipping"
                            />
                          </Box>
                          <Box paddingBlockStart="400">
                            <Button
                              variant={progressBarConfig.freeShipping?.enabled ? "primary" : "secondary"}
                              onClick={() => setProgressBarConfig(prev => ({ 
                                ...prev, 
                                freeShipping: { 
                                  ...prev.freeShipping, 
                                  enabled: !prev.freeShipping?.enabled 
                                } 
                              }))}
                            >
                              {progressBarConfig.freeShipping?.enabled ? "Enabled" : "Disabled"}
                            </Button>
                          </Box>
                        </InlineStack>

                        {progressBarConfig.freeShipping?.enabled && (
                          <Banner status="info">
                            <p>
                              Free shipping indicator will appear at <strong>${(progressBarConfig.freeShipping?.threshold / 100).toFixed(2)}</strong> with a truck icon. 
                              Remember to configure the actual free shipping discount in Shopify's admin.
                            </p>
                          </Banner>
                        )}
                      </BlockStack>
                    </Card>

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

    // Delete ALL discounts that match our function ID OR have GWP in the title
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

    // Convert tiers to metafield format - now using product IDs instead of tags
    const tiersConfig = tiers.map((tier, index) => ({
      id: tier.id,
      name: tier.name,
      thresholdAmount: tier.thresholdAmount,
      maxSelections: tier.maxSelections,
      // Use collection product IDs if available, otherwise fall back to individual giftProductIds
      productIds: tier.collectionProductIds || tier.giftProductIds || [],
      collectionId: tier.collectionId || null,
      collectionHandle: tier.collectionHandle || null
    }));

    console.log('🎯 Creating discount with function ID:', functionId);
    console.log('🎯 Tiers configuration (with product IDs):');
    tiersConfig.forEach((tier, index) => {
      console.log(`  Tier ${index + 1}: ${tier.name}, threshold: $${(tier.thresholdAmount / 100).toFixed(2)}, products: ${tier.productIds.length}`);
    });
    
    // Create a unique title with timestamp
    const uniqueTitle = `GWP Tiered Discount ${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
    
    const createResponse = await admin.graphql(createMutation, {
      variables: {
        automaticAppDiscount: {
          title: uniqueTitle,
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
    
    console.log('🎯 Create discount response:', createData);

    if (createData.data?.discountAutomaticAppCreate?.userErrors?.length > 0) {
      const errors = createData.data.discountAutomaticAppCreate.userErrors;
      console.error('🎯 Discount creation errors:', errors);
      throw new Error(`Failed to create discount: ${errors.map(e => `${e.field}: ${e.message}`).join(', ')}`);
    }

    if (createData.errors) {
      console.error('🎯 GraphQL errors:', createData.errors);
      throw new Error(`GraphQL errors: ${createData.errors.map(e => e.message).join(', ')}`);
    }

    console.log("Successfully created GWP discount:", createData.data?.discountAutomaticAppCreate?.automaticAppDiscount);
  } catch (error) {
    console.error('Error creating/updating automatic discount:', error);
    throw error;
  }
}


