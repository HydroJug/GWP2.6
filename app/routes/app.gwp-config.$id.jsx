import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  TextField,
  InlineStack,
  Badge,
  EmptyState,
  Banner,
  Box,
  Select,
  ButtonGroup,
  Checkbox,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import {
  getGWPSettings,
  saveGWPSettings,
  getOrCreateStorefrontToken,
} from "../lib/storage.server";


// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const { id } = params;

  // Fetch storefront token regardless of new vs edit
  let storefrontToken = null;
  try {
    const tokenRes = await admin.graphql(
      `#graphql
        query {
          currentAppInstallation {
            metafield(namespace: "gwp_internal", key: "storefront_token") {
              value
            }
          }
        }`
    );
    const tokenData = await tokenRes.json();
    storefrontToken =
      tokenData.data?.currentAppInstallation?.metafield?.value || null;
  } catch (e) {
    console.error("Error fetching storefront token:", e);
  }

  // New discount — return empty defaults, do not load from metafield
  if (id === "new") {
    return json({
      settings: {
        tiers: [],
        isActive: false,
        progressBar: {
          enabled: false,
          selector: "",
          position: "below",
          modalBehavior: "auto",
          freeShipping: { enabled: false, threshold: 10000 },
        },
      },
      storefrontToken,
      shop: session.shop,
    });
  }

  // Existing discount — load from metafield
  const settings = await getGWPSettings(admin, session.shop);

  let allGiftProducts = [];
  const allProductIds = [];
  settings.tiers?.forEach((tier) => {
    const productIds = Array.isArray(tier.giftProductIds)
      ? tier.giftProductIds
      : tier.giftProductIds
        ? tier.giftProductIds.split(",").filter((id) => id.trim())
        : [];
    allProductIds.push(...productIds);
  });

  const uniqueProductIds = [...new Set(allProductIds)];

  if (uniqueProductIds.length > 0) {
    try {
      const productQueries = uniqueProductIds.map((id) => `id:${id}`).join(" OR ");
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
        { variables: { query: productQueries } }
      );
      const responseJson = await response.json();
      allGiftProducts = responseJson.data.products.edges.map((edge) => edge.node);
    } catch (error) {
      console.error("Error fetching gift products:", error);
    }
  }

  const tiersWithProducts =
    settings.tiers?.map((tier) => {
      const productIds = Array.isArray(tier.giftProductIds)
        ? tier.giftProductIds
        : tier.giftProductIds
          ? tier.giftProductIds.split(",").filter((id) => id.trim())
          : [];
      const tierProducts = allGiftProducts.filter((product) =>
        productIds.includes(product.id.replace("gid://shopify/Product/", ""))
      );
      return { ...tier, giftProductIds: productIds, giftProducts: tierProducts };
    }) || [];

  return json({
    settings: {
      tiers: tiersWithProducts,
      isActive: settings.isActive,
      progressBar: settings.progressBar || null,
    },
    storefrontToken,
    shop: session.shop,
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

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
      { variables: { query } }
    );
    const responseJson = await response.json();
    return json({
      products: responseJson.data.products.edges.map((edge) => edge.node),
      action: "searchProducts",
    });
  }

  if (action === "searchCollections") {
    const query = formData.get("query");
    try {
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
                  products(first: 1) {
                    edges {
                      node {
                        id
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { query } }
      );
      const responseJson = await response.json();

      if (responseJson.errors) {
        return json({
          collections: [],
          action: "searchCollections",
          error:
            "Failed to search collections: " +
            responseJson.errors.map((e) => e.message).join(", "),
        });
      }

      const collections =
        responseJson.data?.collections?.edges?.map((edge) => {
          const collection = edge.node;
          return {
            ...collection,
            productsCount: collection.productsCount.count,
          };
        }) || [];

      return json({ collections, action: "searchCollections" });
    } catch (error) {
      return json({
        collections: [],
        action: "searchCollections",
        error: "Failed to search collections: " + error.message,
      });
    }
  }

  if (action === "saveSettings") {
    const tiersData = formData.get("tiers");

    try {
      let tiers = JSON.parse(tiersData);
      // Preserve existing progressBar config — it is now managed by the standalone Progress Bar page
      const existingSettings = await getGWPSettings(admin, session.shop);
      const progressBar = existingSettings.progressBar || null;

      const tiersWithProducts = await Promise.all(
        tiers.map(async (tier) => {
          if (tier.collectionId) {
            try {
              const collectionResponse = await admin.graphql(
                `#graphql
                  query getCollectionProducts($id: ID!) {
                    collection(id: $id) {
                      products(first: 250) {
                        edges {
                          node {
                            id
                            title
                            featuredImage { url }
                            variants(first: 10) {
                              edges {
                                node {
                                  id
                                  title
                                  image { url }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }`,
                {
                  variables: {
                    id: `gid://shopify/Collection/${tier.collectionId}`,
                  },
                }
              );
              const collectionData = await collectionResponse.json();
              const products =
                collectionData.data?.collection?.products?.edges || [];
              const productIds = products.map((edge) => edge.node.id);
              const firstProduct = products[0]?.node;
              const displayProducts = products.flatMap((edge) => {
                const product = edge.node;
                return product.variants.edges.map((ve) => ({
                  variantId: ve.node.id.split("/").pop(),
                  productId: product.id.split("/").pop(),
                  title:
                    product.title +
                    (ve.node.title !== "Default Title"
                      ? ` - ${ve.node.title}`
                      : ""),
                  image:
                    ve.node.image?.url || product.featuredImage?.url || null,
                }));
              });
              return {
                ...tier,
                collectionProductIds: productIds,
                displayProducts,
                collectionImageUrl:
                  firstProduct?.featuredImage?.url || tier.collectionImageUrl,
              };
            } catch (error) {
              console.error(
                `Error fetching collection products for tier ${tier.name}:`,
                error
              );
            }
          }

          const displayProducts = (tier.giftProducts || []).flatMap(
            (product) => {
              const variants = product.variants?.edges || [];
              return variants.map((ve) => ({
                variantId: ve.node.id.split("/").pop(),
                productId: product.id.split("/").pop(),
                title:
                  product.title +
                  (ve.node.title !== "Default Title"
                    ? ` - ${ve.node.title}`
                    : ""),
                image: product.featuredImage?.url || null,
              }));
            }
          );
          return { ...tier, displayProducts };
        })
      );

      tiers = tiersWithProducts;

      await saveGWPSettings(admin, session.shop, {
        tiers,
        progressBar,
        isActive: true,
      });

      try {
        await getOrCreateStorefrontToken(admin);
      } catch (tokenError) {
        console.error("Error ensuring Storefront token:", tokenError.message);
      }

      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const cacheDir = "./cache";
        await fs.mkdir(cacheDir, { recursive: true });
        const shopSlug = session.shop.replace(/[^a-zA-Z0-9]/g, "-");
        const configPath = path.join(
          cacheDir,
          `gwp-config-${shopSlug}.json`
        );
        await fs.writeFile(
          configPath,
          JSON.stringify({ tiers, progressBar, isActive: true }, null, 2)
        );
      } catch (cacheErr) {
        console.log("File cache write skipped (non-fatal):", cacheErr.message);
      }

      try {
        await createOrUpdateAutomaticDiscount(admin, session.shop, tiers);
      } catch (discountError) {
        console.error("Error creating automatic discount:", discountError);
      }

      return json({
        success: true,
        message: "Settings saved successfully!",
        action: "saveSettings",
      });
    } catch (error) {
      console.error("Error saving settings:", error);
      return json({
        success: false,
        error: error.message,
        action: "saveSettings",
      });
    }
  }

  return json({ error: "Invalid action" }, { status: 400 });
};

// ─── Shared styles ────────────────────────────────────────────────────────────

const dropdownStyles = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 9999,
  marginTop: "4px",
  background: "white",
  border: "1px solid #c9cccf",
  borderRadius: "8px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
  maxHeight: "280px",
  overflowY: "auto",
};

const dropdownItemStyles = (isSelected) => ({
  display: "flex",
  alignItems: "center",
  gap: "12px",
  width: "100%",
  padding: "10px 14px",
  border: "none",
  borderBottom: "1px solid #f1f2f4",
  background: isSelected ? "#f6f6f7" : "transparent",
  cursor: isSelected ? "default" : "pointer",
  textAlign: "left",
  boxSizing: "border-box",
});

function CollectionThumbnail({ src, alt }) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={{
          width: 36,
          height: 36,
          borderRadius: "4px",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: "4px",
        background: "#f1f2f4",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "18px",
      }}
    >
      📦
    </div>
  );
}

function ProductThumbnail({ src, alt }) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={{
          width: 36,
          height: 36,
          borderRadius: "4px",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: "4px",
        background: "#f1f2f4",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "18px",
      }}
    >
      🛍️
    </div>
  );
}

// ─── Portal dropdown — renders into document.body to escape all stacking contexts

function FloatingDropdown({ anchorRef, visible, onMouseDown, children }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (visible && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    if (!visible) setRect(null);
  }, [visible, anchorRef]);

  if (!visible || !rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      onMouseDown={onMouseDown}
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        zIndex: 99999,
        background: "white",
        border: "1px solid #c9cccf",
        borderRadius: "8px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        maxHeight: "280px",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      {children}
    </div>,
    document.body
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GWPConfigForm() {
  const { settings, storefrontToken, shop } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const appUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://gwp-2-6.vercel.app";
  const scriptUrl = storefrontToken
    ? `${appUrl}/cart-modal?shop=${shop}&token=${storefrontToken}`
    : `${appUrl}/cart-modal?shop=${shop}`;

  const [tiers, setTiers] = useState(settings.tiers || []);
  const [searchQuery, setSearchQuery] = useState("");
  const [collectionSearchQuery, setCollectionSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [collectionSearchResults, setCollectionSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchingCollections, setIsSearchingCollections] = useState(false);
  const [activeTierIndex, setActiveTierIndex] = useState(null);
  const [selectionMode, setSelectionMode] = useState("collection");
  const collectionSearchRef = useRef(null);
  const productSearchRef = useRef(null);

  const isLoading = ["loading", "submitting"].includes(fetcher.state);

  useEffect(() => {
    if (fetcher.data?.action === "searchProducts") {
      setSearchResults(fetcher.data.products || []);
      setIsSearching(false);
    }
    if (fetcher.data?.action === "searchCollections") {
      setCollectionSearchResults(fetcher.data.collections || []);
      setIsSearchingCollections(false);
      if (fetcher.data.error) {
        shopify.toast.show(
          `Collection search error: ${fetcher.data.error}`,
          { isError: true }
        );
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

  // Debounced collection search
  useEffect(() => {
    const query = collectionSearchQuery.trim();
    if (!query) {
      setCollectionSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setIsSearchingCollections(true);
      fetcher.submit(
        { action: "searchCollections", query },
        { method: "POST" }
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [collectionSearchQuery]);

  // Debounced product search
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setIsSearching(true);
      fetcher.submit(
        { action: "searchProducts", query },
        { method: "POST" }
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleAddTier = useCallback(() => {
    const newTier = {
      id: `tier${Date.now()}`,
      thresholdAmount: 7000,
      name: `Tier ${tiers.length + 1}`,
      giftProductIds: [],
      giftProducts: [],
      maxSelections: 1,
      description: "Choose 1 free gift",
      collectionId: null,
      collectionHandle: null,
      collectionTitle: null,
      showOnProgressBar: false,
    };
    setTiers([...tiers, newTier]);
  }, [tiers]);

  const handleRemoveTier = useCallback(
    (tierIndex) => setTiers(tiers.filter((_, i) => i !== tierIndex)),
    [tiers]
  );

  const handleUpdateTier = useCallback(
    (tierIndex, updates) =>
      setTiers(
        tiers.map((tier, i) => (i === tierIndex ? { ...tier, ...updates } : tier))
      ),
    [tiers]
  );

  const handleAddProductToTier = useCallback(
    (tierIndex, product) => {
      const tier = tiers[tierIndex];
      if (!tier.giftProducts.find((p) => p.id === product.id)) {
        const updatedProducts = [...tier.giftProducts, product];
        const updatedProductIds = updatedProducts.map((p) =>
          p.id.replace("gid://shopify/Product/", "")
        );
        handleUpdateTier(tierIndex, {
          giftProducts: updatedProducts,
          giftProductIds: updatedProductIds,
        });
        setSearchResults([]);
        setSearchQuery("");
        setActiveTierIndex(null);
      }
    },
    [tiers, handleUpdateTier]
  );

  const handleAddCollectionToTier = useCallback(
    (tierIndex, collection) => {
      const collectionId = collection.id.replace(
        "gid://shopify/Collection/",
        ""
      );
      handleUpdateTier(tierIndex, {
        collectionId,
        collectionHandle: collection.handle,
        collectionTitle: collection.title,
        giftProducts: [],
        giftProductIds: [],
      });
      setCollectionSearchResults([]);
      setCollectionSearchQuery("");
      setActiveTierIndex(null);
    },
    [handleUpdateTier]
  );

  const handleRemoveProductFromTier = useCallback(
    (tierIndex, productId) => {
      const tier = tiers[tierIndex];
      const updatedProducts = tier.giftProducts.filter(
        (p) => p.id !== productId
      );
      const updatedProductIds = updatedProducts.map((p) =>
        p.id.replace("gid://shopify/Product/", "")
      );
      handleUpdateTier(tierIndex, {
        giftProducts: updatedProducts,
        giftProductIds: updatedProductIds,
      });
    },
    [tiers, handleUpdateTier]
  );

  const handleRemoveCollectionFromTier = useCallback(
    (tierIndex) =>
      handleUpdateTier(tierIndex, {
        collectionId: null,
        collectionHandle: null,
        collectionTitle: null,
      }),
    [handleUpdateTier]
  );

  const handleSaveSettings = useCallback(() => {
    const sortedTiers = [...tiers].sort(
      (a, b) => a.thresholdAmount - b.thresholdAmount
    );
    fetcher.submit(
      {
        action: "saveSettings",
        tiers: JSON.stringify(sortedTiers),
      },
      { method: "POST" }
    );
  }, [tiers, fetcher]);

  const formatPrice = (amount) => `$${(parseInt(amount) / 100).toFixed(2)}`;

  const maxSelectionOptions = [
    { label: "1 gift", value: "1" },
    { label: "2 gifts", value: "2" },
    { label: "3 gifts", value: "3" },
    { label: "4 gifts", value: "4" },
    { label: "5 gifts", value: "5" },
  ];

  return (
    <Page
      backAction={{ content: "Gift with Purchase", url: "/app/gwp-config" }}
      title="GWP Configuration"
    >
      <TitleBar title="Gift with Purchase" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <style>{`
              .gwp-config-card .Polaris-ShadowBevel,
              .gwp-config-card .Polaris-Box,
              .gwp-config-card .Polaris-Card {
                overflow: visible !important;
              }
            `}</style>
            <div className="gwp-config-card">
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">
                  Multi-Tier Gift with Purchase Configuration
                </Text>

                <Banner tone="info">
                  <p>
                    Create multiple gift tiers with different threshold amounts.
                    Customers unlock higher tiers as their cart value increases
                    and can select multiple gifts if configured. Tiers are
                    automatically sorted by threshold amount.
                  </p>
                </Banner>

                {storefrontToken && (
                  <Banner tone="success" title="Script Installation">
                    <BlockStack gap="200">
                      <Text>
                        Add this script to your theme to enable the GWP modal:
                      </Text>
                      <Box
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="100"
                      >
                        <Text variant="bodyMd" fontFamily="mono" breakWord>
                          {`<script src="${scriptUrl}"></script>`}
                        </Text>
                      </Box>
                      <Text variant="bodySm" tone="subdued">
                        The Storefront Access Token is included in the URL for
                        reliable config loading.
                      </Text>
                    </BlockStack>
                  </Banner>
                )}

                {!storefrontToken && (
                  <Banner tone="warning" title="Script Installation">
                    <Text>
                      Save your settings to generate a Storefront Access Token.
                      This enables reliable config loading on your storefront.
                    </Text>
                  </Banner>
                )}

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
                    <p>
                      Create your first gift tier to get started with
                      multi-tier gift with purchase.
                    </p>
                    <Button onClick={handleAddTier} variant="primary">
                      Create First Tier
                    </Button>
                  </EmptyState>
                ) : (
                  <div style={{ position: "relative", zIndex: 2 }}>
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
                                onClick={() =>
                                  setActiveTierIndex(
                                    activeTierIndex === tierIndex
                                      ? null
                                      : tierIndex
                                  )
                                }
                                variant={
                                  activeTierIndex === tierIndex
                                    ? "primary"
                                    : "secondary"
                                }
                              >
                                {activeTierIndex === tierIndex
                                  ? "Close"
                                  : "Add Products"}
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
                                onChange={(value) =>
                                  handleUpdateTier(tierIndex, { name: value })
                                }
                                placeholder="e.g., Bronze Tier"
                              />
                            </Box>
                            <Box minWidth="200px">
                              <TextField
                                label="Threshold (cents)"
                                type="number"
                                value={tier.thresholdAmount.toString()}
                                onChange={(value) =>
                                  handleUpdateTier(tierIndex, {
                                    thresholdAmount: parseInt(value) || 0,
                                  })
                                }
                                helpText={`${formatPrice(tier.thresholdAmount)} — Cart total required`}
                                placeholder="8000"
                              />
                            </Box>
                            <Box minWidth="150px">
                              <Select
                                label="Max Selections"
                                options={maxSelectionOptions}
                                value={tier.maxSelections.toString()}
                                onChange={(value) =>
                                  handleUpdateTier(tierIndex, {
                                    maxSelections: parseInt(value),
                                  })
                                }
                              />
                            </Box>
                          </InlineStack>

                          <TextField
                            label="Description"
                            value={tier.description}
                            onChange={(value) =>
                              handleUpdateTier(tierIndex, { description: value })
                            }
                            placeholder="e.g., Choose 1 free gift"
                            helpText="Shown to customers at checkout"
                          />

                          <Checkbox
                            label="Show tier on progress bar"
                            helpText="Progress bar must be enabled for this to work. Configure it in the Progress Bar settings."
                            checked={tier.showOnProgressBar ?? false}
                            onChange={(checked) =>
                              handleUpdateTier(tierIndex, { showOnProgressBar: checked })
                            }
                          />

                          {/* Product/Collection picker for active tier */}
                          {activeTierIndex === tierIndex && (
                            <Card sectioned>
                              <BlockStack gap="300">
                                <InlineStack align="space-between">
                                  <Text as="h5" variant="headingSm">
                                    Configure {tier.name} Gifts
                                  </Text>
                                  <ButtonGroup segmented>
                                    <Button
                                      pressed={selectionMode === "collection"}
                                      onClick={() =>
                                        setSelectionMode("collection")
                                      }
                                    >
                                      Use Collection
                                    </Button>
                                    <Button
                                      pressed={selectionMode === "products"}
                                      onClick={() =>
                                        setSelectionMode("products")
                                      }
                                    >
                                      Individual Products
                                    </Button>
                                  </ButtonGroup>
                                </InlineStack>

                                {selectionMode === "collection" ? (
                                  <BlockStack gap="200">
                                    <Text variant="bodySm" tone="subdued">
                                      Select a collection to automatically
                                      include all its products as gift options.
                                    </Text>
                                    <div ref={collectionSearchRef}>
                                      <TextField
                                        label="Search collections"
                                        value={collectionSearchQuery}
                                        onChange={setCollectionSearchQuery}
                                        placeholder="Type to search collections..."
                                        loading={isSearchingCollections}
                                        autoComplete="off"
                                        clearButton
                                        onClearButtonClick={() => {
                                          setCollectionSearchQuery("");
                                          setCollectionSearchResults([]);
                                        }}
                                      />
                                      <FloatingDropdown
                                        anchorRef={collectionSearchRef}
                                        visible={collectionSearchResults.length > 0}
                                        onMouseDown={(e) => e.preventDefault()}
                                      >
                                        {collectionSearchResults.map(
                                          (collection) => {
                                            const isSelected =
                                              tiers[activeTierIndex]?.collectionId ===
                                              collection.id.replace("gid://shopify/Collection/", "");
                                            return (
                                              <button
                                                key={collection.id}
                                                onClick={() =>
                                                  !isSelected &&
                                                  handleAddCollectionToTier(tierIndex, collection)
                                                }
                                                style={dropdownItemStyles(isSelected)}
                                              >
                                                <CollectionThumbnail
                                                  src={collection.image?.url}
                                                  alt={collection.image?.altText || collection.title}
                                                />
                                                <div style={{ flex: 1 }}>
                                                  <div style={{ fontWeight: 500, fontSize: "14px", color: "#202223" }}>
                                                    {collection.title}
                                                  </div>
                                                  <div style={{ fontSize: "13px", color: "#6d7175" }}>
                                                    {collection.productsCount} products
                                                  </div>
                                                </div>
                                                {isSelected && (
                                                  <span style={{ color: "#008060", fontWeight: 600, fontSize: "13px", flexShrink: 0 }}>
                                                    Selected
                                                  </span>
                                                )}
                                              </button>
                                            );
                                          }
                                        )}
                                      </FloatingDropdown>
                                    </div>
                                  </BlockStack>
                                ) : (
                                  <BlockStack gap="200">
                                    <Text variant="bodySm" tone="subdued">
                                      Search and select individual products as
                                      gift options.
                                    </Text>
                                    <div ref={productSearchRef}>
                                      <TextField
                                        label="Search products"
                                        value={searchQuery}
                                        onChange={setSearchQuery}
                                        placeholder="Type to search products..."
                                        loading={isSearching}
                                        autoComplete="off"
                                        clearButton
                                        onClearButtonClick={() => {
                                          setSearchQuery("");
                                          setSearchResults([]);
                                        }}
                                      />
                                      <FloatingDropdown
                                        anchorRef={productSearchRef}
                                        visible={searchResults.length > 0}
                                        onMouseDown={(e) => e.preventDefault()}
                                      >
                                        {searchResults.map((product) => {
                                          const isSelected =
                                            tiers[activeTierIndex]?.giftProducts?.find(
                                              (p) => p.id === product.id
                                            );
                                          const price =
                                            product.variants.edges[0]?.node.price || "0.00";
                                          return (
                                            <button
                                              key={product.id}
                                              onClick={() =>
                                                !isSelected &&
                                                handleAddProductToTier(tierIndex, product)
                                              }
                                              style={dropdownItemStyles(!!isSelected)}
                                            >
                                              <ProductThumbnail
                                                src={product.featuredImage?.url}
                                                alt={product.featuredImage?.altText || product.title}
                                              />
                                              <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 500, fontSize: "14px", color: "#202223" }}>
                                                  {product.title}
                                                </div>
                                                <div style={{ fontSize: "13px", color: "#6d7175" }}>
                                                  ${price} · {product.status}
                                                </div>
                                              </div>
                                              {isSelected && (
                                                <span style={{ color: "#008060", fontWeight: 600, fontSize: "13px", flexShrink: 0 }}>
                                                  Added
                                                </span>
                                              )}
                                            </button>
                                          );
                                        })}
                                      </FloatingDropdown>
                                    </div>
                                  </BlockStack>
                                )}
                              </BlockStack>
                            </Card>
                          )}

                          {/* Display selected collection or products */}
                          {tier.collectionId ? (
                            <Card>
                              <BlockStack gap="300">
                                <Text as="h5" variant="headingSm">
                                  Selected Collection
                                </Text>
                                <InlineStack
                                  align="space-between"
                                  blockAlign="center"
                                >
                                  <BlockStack gap="100">
                                    <Text variant="bodyMd" fontWeight="bold">
                                      {tier.collectionTitle}
                                    </Text>
                                    <Text variant="bodySm" tone="subdued">
                                      Handle: {tier.collectionHandle}
                                    </Text>
                                    <Badge tone="success">
                                      Collection-based gifts
                                    </Badge>
                                  </BlockStack>
                                  <Button
                                    onClick={() =>
                                      handleRemoveCollectionFromTier(tierIndex)
                                    }
                                    variant="plain"
                                    tone="critical"
                                  >
                                    Remove
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          ) : tier.giftProducts.length > 0 ? (
                            <Card>
                              <BlockStack gap="300">
                                <Text as="h5" variant="headingSm">
                                  Gift Products ({tier.giftProducts.length})
                                </Text>
                                <BlockStack gap="200">
                                  {tier.giftProducts.map((product) => {
                                    const price =
                                      product.variants.edges[0]?.node.price ||
                                      "0.00";
                                    return (
                                      <InlineStack
                                        key={product.id}
                                        align="space-between"
                                        blockAlign="center"
                                        gap="300"
                                      >
                                        <InlineStack
                                          gap="300"
                                          blockAlign="center"
                                        >
                                          <ProductThumbnail
                                            src={product.featuredImage?.url}
                                            alt={
                                              product.featuredImage?.altText ||
                                              product.title
                                            }
                                          />
                                          <BlockStack gap="050">
                                            <Text
                                              variant="bodyMd"
                                              fontWeight="semibold"
                                            >
                                              {product.title}
                                            </Text>
                                            <Text
                                              variant="bodySm"
                                              tone="subdued"
                                            >
                                              Original price: ${price}
                                            </Text>
                                          </BlockStack>
                                        </InlineStack>
                                        <Button
                                          onClick={() =>
                                            handleRemoveProductFromTier(
                                              tierIndex,
                                              product.id
                                            )
                                          }
                                          variant="plain"
                                          tone="critical"
                                        >
                                          Remove
                                        </Button>
                                      </InlineStack>
                                    );
                                  })}
                                </BlockStack>
                              </BlockStack>
                            </Card>
                          ) : activeTierIndex !== tierIndex ? (
                            <EmptyState
                              heading={`No gifts configured for ${tier.name}`}
                              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                            >
                              <p>
                                Select a collection or add individual products
                                that customers can choose as free gifts for this
                                tier.
                              </p>
                            </EmptyState>
                          ) : null}
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                  </div>
                )}

                {tiers.length > 0 && (
                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      onClick={handleSaveSettings}
                      loading={isLoading}
                      disabled={
                        tiers.some(
                          (tier) =>
                            !tier.collectionId &&
                            tier.giftProducts.length === 0
                        )
                      }
                    >
                      Save Settings
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
            </div>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

// ─── Helper: create / update the Shopify automatic discount ──────────────────

async function createOrUpdateAutomaticDiscount(admin, shop, tiers) {
  try {
    const existingDiscountsResponse = await admin.graphql(`
      query {
        discountNodes(first: 250) {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                appDiscountType { functionId }
              }
            }
          }
        }
      }
    `);
    const existingDiscountsData = await existingDiscountsResponse.json();
    const allDiscounts =
      existingDiscountsData.data?.discountNodes?.nodes || [];

    const functionResponse = await admin.graphql(`
      query {
        shopifyFunctions(first: 50) {
          nodes { id title apiType }
        }
      }
    `);
    const functionData = await functionResponse.json();

    let targetFunctionId = null;
    if (functionData.data?.shopifyFunctions?.nodes?.length > 0) {
      const gwpFunction = functionData.data.shopifyFunctions.nodes.find(
        (node) =>
          (node.title?.toLowerCase().includes("gwp") ||
            node.title?.toLowerCase().includes("discount") ||
            node.title?.toLowerCase().includes("cart")) &&
          node.apiType === "discount"
      );
      targetFunctionId = gwpFunction?.id;
    }

    if (!targetFunctionId) {
      const anyDiscountFunction =
        functionData.data?.shopifyFunctions?.nodes?.find(
          (node) => node.apiType === "discount"
        );
      if (anyDiscountFunction) {
        targetFunctionId = anyDiscountFunction.id;
      } else {
        throw new Error(
          "No discount function found for this app. Deploy the discount extension first."
        );
      }
    }

    for (const node of allDiscounts) {
      const discount = node?.discount;
      const discountId = node.id;
      const discountFunctionId = discount?.appDiscountType?.functionId;
      if (!discount || !discountFunctionId) continue;

      const title = discount?.title?.toLowerCase() || "";
      const status = discount?.status;
      if (status === "EXPIRED" || status === "SCHEDULED") continue;

      const matchesFunctionId = discountFunctionId === targetFunctionId;
      const matchesTitle =
        title.includes("gwp") ||
        title.includes("gift") ||
        title.includes("tiered discount");

      if (matchesFunctionId || matchesTitle) {
        try {
          await admin.graphql(
            `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
              discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
                automaticAppDiscount { discountId title status }
                userErrors { field code message }
              }
            }`,
            {
              variables: {
                id: discountId,
                automaticAppDiscount: { endsAt: new Date().toISOString() },
              },
            }
          );
        } catch (error) {
          console.error(
            `Error deactivating discount ${discountId}:`,
            error.message
          );
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const functionId = targetFunctionId;
    if (!functionId) throw new Error("GWP discount function not found");

    const tiersConfig = tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      thresholdAmount: tier.thresholdAmount,
      maxSelections: tier.maxSelections,
      productIds: tier.collectionProductIds || tier.giftProductIds || [],
      collectionId: tier.collectionId || null,
      collectionHandle: tier.collectionHandle || null,
    }));

    const tierLabels = tiers.map((tier) => {
      const collectionName = tier.collectionTitle || tier.name || "Collection";
      const threshold = `$${(tier.thresholdAmount / 100).toFixed(0)}`;
      return `${collectionName} ${threshold}`;
    });
    const date = new Date().toISOString().slice(0, 10);
    const uniqueTitle = `GWP - ${tierLabels.join(" | ")} - ${date}`;

    const createResponse = await admin.graphql(
      `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId title }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          automaticAppDiscount: {
            title: uniqueTitle,
            functionId,
            discountClasses: ["PRODUCT"],
            startsAt: new Date().toISOString(),
            combinesWith: {
              orderDiscounts: true,
              productDiscounts: true,
              shippingDiscounts: true,
            },
            metafields: [
              {
                namespace: "gwp",
                key: "tiers",
                type: "json",
                value: JSON.stringify(tiersConfig),
              },
            ],
          },
        },
      }
    );

    const createData = await createResponse.json();

    if (createData.data?.discountAutomaticAppCreate?.userErrors?.length > 0) {
      const errors = createData.data.discountAutomaticAppCreate.userErrors;
      throw new Error(
        `Failed to create discount: ${errors.map((e) => `${e.field}: ${e.message}`).join(", ")}`
      );
    }

    if (createData.errors) {
      throw new Error(
        `GraphQL errors: ${createData.errors.map((e) => e.message).join(", ")}`
      );
    }
  } catch (error) {
    console.error("Error creating/updating automatic discount:", error);
    throw error;
  }
}
