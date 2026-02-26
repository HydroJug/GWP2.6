import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  LegacyCard,
  Button,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  ButtonGroup,
  Modal,
  TextField,
  Select,
  ChoiceList,
  Banner,
  EmptyState,
  ResourceList,
  ResourceItem,
  Checkbox,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Look up the Tapcart discount function ID dynamically
  let tapcartFunctionId = null;
  try {
    const functionsResponse = await admin.graphql(`
      query {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `);
    const functionsJson = await functionsResponse.json();
    const fn = functionsJson.data?.shopifyFunctions?.nodes?.find(
      (f) => f.title === "Tapcart Exclusive Discount Function"
    );
    tapcartFunctionId = fn?.id || null;
  } catch (e) {
    console.error("Could not look up Tapcart function ID:", e);
  }

  // Fetch existing discounts
  const discountsResponse = await admin.graphql(`
    query getDiscounts {
      codeDiscountNodes(first: 50) {
        edges {
          node {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                codes(first: 1) { edges { node { code } } }
                startsAt
                endsAt
                status
                usageLimit
                appliesOncePerCustomer
              }
              ... on DiscountCodeBxgy {
                title
                codes(first: 1) { edges { node { code } } }
                startsAt
                endsAt
                status
                usageLimit
                appliesOncePerCustomer
              }
              ... on DiscountCodeFreeShipping {
                title
                codes(first: 1) { edges { node { code } } }
                startsAt
                endsAt
                status
                usageLimit
                appliesOncePerCustomer
              }
              ... on DiscountCodeApp {
                title
                codes(first: 1) { edges { node { code } } }
                startsAt
                endsAt
                status
                usageLimit
                appliesOncePerCustomer
              }
            }
          }
        }
      }
      automaticDiscountNodes(first: 50) {
        edges {
          node {
            id
            automaticDiscount {
              ... on DiscountAutomaticBasic {
                title
                startsAt
                endsAt
                status
              }
              ... on DiscountAutomaticBxgy {
                title
                startsAt
                endsAt
                status
              }
              ... on DiscountAutomaticFreeShipping {
                title
                startsAt
                endsAt
                status
              }
              ... on DiscountAutomaticApp {
                title
                startsAt
                endsAt
                status
              }
            }
          }
        }
      }
    }
  `);
  const discountsJson = await discountsResponse.json();

  // Fetch products
  const productsResponse = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node {
            id
            title
            handle
            images(first: 1) {
              edges { node { url altText } }
            }
          }
        }
      }
    }
  `);
  const productsJson = await productsResponse.json();

  // Fetch sales channels
  const salesChannelsResponse = await admin.graphql(`
    query { publications(first: 20) { nodes { id name } } }
  `);
  const salesChannelsJson = await salesChannelsResponse.json();

  // Fetch customers (optionally filtered by search)
  const url = new URL(request.url);
  const customerSearchQuery = url.searchParams.get("customerSearch") || "";
  const customersResponse = await admin.graphql(
    `query getCustomers($query: String) {
      customers(first: 20, query: $query) {
        edges { node { id email firstName lastName } }
      }
    }`,
    { variables: { query: customerSearchQuery } }
  );
  const customersJson = await customersResponse.json();

  return json({
    tapcartFunctionId,
    discounts: discountsJson.data,
    products: productsJson.data.products.edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      image: edge.node.images.edges[0]?.node?.url || null,
    })),
    salesChannels: salesChannelsJson.data.publications.nodes,
    customers: customersJson.data.customers.edges.map((edge) => edge.node),
  });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "create") {
    const discountType = formData.get("discountType");
    const discountMethod = formData.get("discountMethod");
    const title = formData.get("title");
    const code = formData.get("code");
    const startDateTime = formData.get("startDateTime");
    const endDateTime = formData.get("endDateTime");
    const usageLimit = formData.get("usageLimit");
    const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
    const eligibilityType = formData.get("eligibilityType");
    const customerSegments = formData.get("customerSegments")
      ? formData.get("customerSegments").split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const specificCustomers = formData.get("specificCustomers")
      ? formData.get("specificCustomers").split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const minimumSpent = formData.get("minimumSpent");
    const productSelectionType = formData.get("productSelectionType");
    const selectedProductsString = formData.get("selectedProducts");
    const selectedProducts = selectedProductsString
      ? selectedProductsString.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const collections = formData.get("collections")
      ? formData.get("collections").split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const productTags = formData.get("productTags")
      ? formData.get("productTags").split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const selectedSalesChannels =
      formData.get("selectedSalesChannels")?.split(",").filter(Boolean) || [];
    const appExclusive = formData.get("appExclusive") === "true";
    const functionId = formData.get("functionId");

    const schedulingFields = {};
    if (startDateTime) schedulingFields.startsAt = new Date(startDateTime).toISOString();
    if (endDateTime) schedulingFields.endsAt = new Date(endDateTime).toISOString();

    const functionConfig = {
      discountType,
      discountMethod,
      productDiscountAmount: formData.get("productDiscountAmount"),
      productDiscountPercentage: formData.get("productDiscountPercentage"),
      orderDiscountAmount: formData.get("orderDiscountAmount"),
      orderDiscountPercentage: formData.get("orderDiscountPercentage"),
      freeShippingMinimumAmount: formData.get("freeShippingMinimumAmount"),
      buyQuantity: formData.get("buyQuantity"),
      getQuantity: formData.get("getQuantity"),
      buyXGetYDiscountType: formData.get("buyXGetYDiscountType"),
      buyXGetYValue: formData.get("buyXGetYValue"),
      productSelectionType,
      selectedProducts: formData.get("selectedProducts"),
      collections: formData.get("collections"),
      productTags: formData.get("productTags"),
      eligibilityType,
      customerSegments,
      specificCustomers,
      minimumSpent,
      appExclusive,
      channelKey: "channel",
      channelValue: "tapcart",
    };

    let mutation;
    let variables;

    if (!functionId) {
      return json({ error: "Tapcart function not deployed yet. Please run 'shopify app deploy' first." });
    }

    if (discountType === "automatic") {
      mutation = `
        mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
          discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }
      `;
      variables = {
        automaticAppDiscount: {
          title,
          functionId,
          ...schedulingFields,
          discountClasses: ["ORDER"],
          metafields: [
            {
              namespace: "tapcart",
              key: "discount_config",
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
        },
      };
    } else if (discountType === "code") {
      let customerSelection;
      if (eligibilityType === "all_customers") {
        customerSelection = { all: true };
      } else if (eligibilityType === "specific_segments") {
        customerSelection = { segmentIds: customerSegments };
      } else if (eligibilityType === "specific_customers") {
        customerSelection = { customerIds: specificCustomers };
      }

      mutation = `
        mutation discountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
          discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
            codeAppDiscount { discountId }
            userErrors { field message }
          }
        }
      `;
      variables = {
        codeAppDiscount: {
          title,
          code,
          functionId,
          ...schedulingFields,
          usageLimit: usageLimit ? parseInt(usageLimit) : null,
          appliesOncePerCustomer,
          discountClasses: ["ORDER"],
          metafields: [
            {
              namespace: "tapcart",
              key: "discount_config",
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
          ...(customerSelection ? { customerSelection } : {}),
        },
      };
    }

    if (mutation && variables) {
      try {
        const response = await admin.graphql(mutation, { variables });
        const responseJson = await response.json();

        const mutationKey = discountType === "automatic"
          ? "discountAutomaticAppCreate"
          : "discountCodeAppCreate";
        const userErrors = responseJson.data?.[mutationKey]?.userErrors || [];

        if (userErrors.length > 0) {
          return json({ error: userErrors[0].message });
        }
        if (responseJson.errors) {
          return json({ error: responseJson.errors[0].message });
        }

        return json({ success: true });
      } catch (error) {
        return json({ error: error.message });
      }
    }

    return json({ error: "Invalid discount configuration" });
  }

  return json({ success: true });
};

export default function TapcartDiscountsPage() {
  const { tapcartFunctionId, discounts, products, salesChannels, customers } = useLoaderData();
  const submit = useSubmit();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [salesChannelModalOpen, setSalesChannelModalOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerSearchResults, setCustomerSearchResults] = useState(customers);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([]);

  const emptyForm = {
    discountType: "automatic",
    discountMethod: "amount_off_products",
    title: "",
    code: "",
    startDateTime: "",
    endDateTime: "",
    usageLimit: "",
    appliesOncePerCustomer: false,
    productDiscountAmount: "",
    productDiscountPercentage: "",
    orderDiscountAmount: "",
    orderDiscountPercentage: "",
    minimumOrderAmount: "",
    freeShippingMinimumAmount: "",
    buyQuantity: "1",
    getQuantity: "1",
    buyXGetYDiscountType: "free",
    buyXGetYValue: "",
    productSelectionType: "all_products",
    selectedProducts: [],
    collections: "",
    productTags: "",
    eligibilityType: "all_customers",
    customerSegments: [],
    specificCustomers: "",
    minimumSpent: "",
    selectedSalesChannels: [],
    appExclusive: true,
  };

  const [formData, setFormData] = useState(emptyForm);

  const handleInputChange = useCallback((key, value) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const filteredProducts = products.filter(
    (product) =>
      product.title.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
      product.handle.toLowerCase().includes(productSearchQuery.toLowerCase())
  );

  const handleProductSelect = useCallback(
    (product) => {
      const isAlreadySelected = formData.selectedProducts.some((p) => p.id === product.id);
      if (!isAlreadySelected) {
        setFormData((prev) => ({
          ...prev,
          selectedProducts: [...prev.selectedProducts, product],
        }));
      }
      setProductSearchQuery("");
    },
    [formData.selectedProducts]
  );

  const handleProductRemove = useCallback((productId) => {
    setFormData((prev) => ({
      ...prev,
      selectedProducts: prev.selectedProducts.filter((p) => p.id !== productId),
    }));
  }, []);

  const handleSubmit = useCallback(async () => {
    setErrorMessage("");
    setSuccessMessage("");
    setIsSubmitting(true);

    if (!formData.title.trim()) {
      setErrorMessage("Title is required");
      setIsSubmitting(false);
      return;
    }

    if (formData.discountType === "code" && !formData.code.trim()) {
      setErrorMessage("Discount code is required for code discounts");
      setIsSubmitting(false);
      return;
    }

    if (formData.discountMethod === "amount_off_products") {
      const amount = parseFloat(formData.productDiscountAmount) || 0;
      const percentage = parseFloat(formData.productDiscountPercentage) || 0;
      if (amount === 0 && percentage === 0) {
        setErrorMessage("Please enter either an amount or percentage for product discount");
        setIsSubmitting(false);
        return;
      }
    }

    if (formData.discountMethod === "amount_off_order") {
      const amount = parseFloat(formData.orderDiscountAmount) || 0;
      const percentage = parseFloat(formData.orderDiscountPercentage) || 0;
      if (amount === 0 && percentage === 0) {
        setErrorMessage("Please enter either an amount or percentage for order discount");
        setIsSubmitting(false);
        return;
      }
    }

    const formDataToSubmit = new FormData();
    formDataToSubmit.append("action", "create");
    formDataToSubmit.append("functionId", tapcartFunctionId || "");

    Object.entries(formData).forEach(([key, value]) => {
      if (key === "selectedProducts") {
        formDataToSubmit.append(key, value.map((p) => p.id).join(","));
      } else if (key === "customerSegments") {
        formDataToSubmit.append(key, value.join(","));
      } else {
        formDataToSubmit.append(key, value);
      }
    });

    // Include selected customer IDs for specific_customers eligibility
    if (formData.eligibilityType === "specific_customers" && selectedCustomerIds.length > 0) {
      formDataToSubmit.set("specificCustomers", selectedCustomerIds.join(","));
    }

    try {
      await submit(formDataToSubmit, { method: "post" });
      setSuccessMessage("Discount created successfully!");
      setIsModalOpen(false);
      setIsSubmitting(false);
      setFormData(emptyForm);
      setSelectedCustomerIds([]);
    } catch (error) {
      setErrorMessage("Failed to create discount. Please try again.");
      setIsSubmitting(false);
    }
  }, [formData, submit, tapcartFunctionId, selectedCustomerIds]);

  const formatDiscounts = (discounts) => {
    const formatted = [];

    discounts.codeDiscountNodes?.edges?.forEach(({ node }) => {
      const discount = node.codeDiscount;
      if (!discount?.title) return;
      formatted.push({
        id: node.id,
        title: discount.title,
        type: "Code",
        code: discount.codes?.edges?.[0]?.node?.code || "",
        status: discount.status,
        startDate: discount.startsAt,
        endDate: discount.endsAt,
      });
    });

    discounts.automaticDiscountNodes?.edges?.forEach(({ node }) => {
      const discount = node.automaticDiscount;
      if (!discount?.title) return;
      formatted.push({
        id: node.id,
        title: discount.title,
        type: "Automatic",
        code: "",
        status: discount.status,
        startDate: discount.startsAt,
        endDate: discount.endsAt,
      });
    });

    return formatted;
  };

  const discountRows = formatDiscounts(discounts);

  const getStatusBadge = (status) => {
    const statusMap = {
      ACTIVE: { tone: "success", text: "Active" },
      SCHEDULED: { tone: "info", text: "Scheduled" },
      EXPIRED: { tone: "critical", text: "Expired" },
      PAUSED: { tone: "warning", text: "Paused" },
    };
    const statusInfo = statusMap[status] || { tone: "subdued", text: status };
    return <Badge tone={statusInfo.tone}>{statusInfo.text}</Badge>;
  };

  const formatDate = (dateString) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <Page
      title="Tapcart Exclusive Discounts"
      subtitle="Manage app-exclusive discounts for Tapcart mobile app users"
      primaryAction={{
        content: "Create discount",
        onAction: () => {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const currentDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
          setFormData((prev) => ({ ...prev, startDateTime: currentDateTime }));
          setIsModalOpen(true);
        },
        disabled: !tapcartFunctionId,
      }}
    >
      <TitleBar title="Tapcart Discounts" />

      {!tapcartFunctionId && (
        <Banner tone="warning">
          <Text variant="bodyMd">
            The Tapcart discount function is not deployed yet. Run{" "}
            <code>shopify app deploy</code> to deploy it, then refresh this page.
          </Text>
        </Banner>
      )}

      {errorMessage && (
        <Banner tone="critical" onDismiss={() => setErrorMessage("")}>
          {errorMessage}
        </Banner>
      )}

      {successMessage && (
        <Banner tone="success" onDismiss={() => setSuccessMessage("")}>
          {successMessage}
        </Banner>
      )}

      <Layout>
        <Layout.Section>
          <LegacyCard>
            <ResourceList
              items={discountRows}
              renderItem={(item) => (
                <ResourceItem id={item.id} accessibilityLabel={`View ${item.title}`}>
                  <InlineStack align="space-between">
                    <BlockStack gap="xs">
                      <Text variant="bodyMd" fontWeight="bold">
                        {item.title}
                      </Text>
                      <InlineStack gap="xs">
                        <Badge tone="info">{item.type}</Badge>
                        {item.code && <Badge tone="subdued">Code: {item.code}</Badge>}
                        {getStatusBadge(item.status)}
                      </InlineStack>
                      <Text variant="bodySm" tone="subdued">
                        {formatDate(item.startDate)} - {formatDate(item.endDate)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </ResourceItem>
              )}
              emptyState={
                <EmptyState
                  heading="Create your first Tapcart exclusive discount"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Offer exclusive discounts to customers shopping through your Tapcart mobile
                    app.
                  </p>
                </EmptyState>
              }
            />
          </LegacyCard>
        </Layout.Section>
      </Layout>

      {/* Create Discount Modal */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Create Tapcart Exclusive Discount"
        primaryAction={{
          content: isSubmitting ? "Creating..." : "Create discount",
          onAction: handleSubmit,
          loading: isSubmitting,
          disabled: isSubmitting,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setIsModalOpen(false) }]}
        large
      >
        <Modal.Section>
          <BlockStack gap="loose">
            {/* Discount Type */}
            <ChoiceList
              title="Discount Type"
              choices={[
                { label: "Automatic discount", value: "automatic" },
                { label: "Discount code", value: "code" },
              ]}
              selected={[formData.discountType]}
              onChange={(selected) => handleInputChange("discountType", selected[0])}
            />

            {formData.discountType === "code" && (
              <TextField
                label="Discount code"
                value={formData.code}
                onChange={(value) => handleInputChange("code", value)}
                placeholder="e.g., TAPCART10"
                helpText="Customers will enter this code to get the discount"
              />
            )}

            {/* Discount Method */}
            <ChoiceList
              title="Discount Method"
              choices={[
                { label: "Amount off products", value: "amount_off_products" },
                { label: "Buy X get Y", value: "buy_x_get_y" },
                { label: "Amount off order", value: "amount_off_order" },
                { label: "Free shipping", value: "free_shipping" },
              ]}
              selected={[formData.discountMethod]}
              onChange={(selected) => handleInputChange("discountMethod", selected[0])}
            />

            {/* Product Selection */}
            {(formData.discountMethod === "amount_off_products" ||
              formData.discountMethod === "buy_x_get_y") && (
              <BlockStack gap="base">
                <Text variant="headingMd">Product Selection</Text>
                <ChoiceList
                  title="Which products should this discount apply to?"
                  choices={[
                    { label: "All products", value: "all_products" },
                    { label: "Specific products", value: "specific_products" },
                    { label: "Collections", value: "collections" },
                    { label: "Product tags", value: "product_tags" },
                  ]}
                  selected={[formData.productSelectionType]}
                  onChange={(selected) => handleInputChange("productSelectionType", selected[0])}
                />

                {formData.productSelectionType === "specific_products" && (
                  <BlockStack gap="base">
                    <TextField
                      label="Search products"
                      value={productSearchQuery}
                      onChange={setProductSearchQuery}
                      placeholder="Search by product name..."
                    />
                    {productSearchQuery && filteredProducts.length > 0 && (
                      <Banner tone="info">
                        <BlockStack gap="xs">
                          <Text variant="headingSm">Search Results:</Text>
                          {filteredProducts.slice(0, 5).map((product) => (
                            <Button
                              key={product.id}
                              size="slim"
                              onClick={() => handleProductSelect(product)}
                              disabled={formData.selectedProducts.some((p) => p.id === product.id)}
                            >
                              {product.title}
                            </Button>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}
                    {formData.selectedProducts.length > 0 && (
                      <BlockStack gap="xs">
                        <Text variant="headingSm">Selected Products:</Text>
                        {formData.selectedProducts.map((product) => (
                          <InlineStack key={product.id} align="space-between">
                            <Text>{product.title}</Text>
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => handleProductRemove(product.id)}
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                )}

                {formData.productSelectionType === "collections" && (
                  <TextField
                    label="Collection IDs (comma-separated)"
                    value={formData.collections}
                    onChange={(value) => handleInputChange("collections", value)}
                    placeholder="gid://shopify/Collection/123456789"
                    helpText="Enter Shopify collection GIDs separated by commas"
                  />
                )}

                {formData.productSelectionType === "product_tags" && (
                  <TextField
                    label="Product tags (comma-separated)"
                    value={formData.productTags}
                    onChange={(value) => handleInputChange("productTags", value)}
                    placeholder="e.g., sale, featured, new"
                  />
                )}
              </BlockStack>
            )}

            {/* Title */}
            <TextField
              label="Title"
              value={formData.title}
              onChange={(value) => handleInputChange("title", value)}
              placeholder="e.g., Tapcart App Exclusive - 10% Off"
              required
            />

            {/* Method-specific fields */}
            {formData.discountMethod === "amount_off_products" && (
              <InlineStack gap="base">
                <TextField
                  label="Amount off ($)"
                  type="number"
                  value={formData.productDiscountAmount}
                  onChange={(value) => handleInputChange("productDiscountAmount", value)}
                  prefix="$"
                  min={0}
                />
                <TextField
                  label="Percentage off (%)"
                  type="number"
                  value={formData.productDiscountPercentage}
                  onChange={(value) => handleInputChange("productDiscountPercentage", value)}
                  suffix="%"
                  min={0}
                  max={100}
                />
              </InlineStack>
            )}

            {formData.discountMethod === "amount_off_order" && (
              <BlockStack gap="base">
                <InlineStack gap="base">
                  <TextField
                    label="Amount off ($)"
                    type="number"
                    value={formData.orderDiscountAmount}
                    onChange={(value) => handleInputChange("orderDiscountAmount", value)}
                    prefix="$"
                    min={0}
                  />
                  <TextField
                    label="Percentage off (%)"
                    type="number"
                    value={formData.orderDiscountPercentage}
                    onChange={(value) => handleInputChange("orderDiscountPercentage", value)}
                    suffix="%"
                    min={0}
                    max={100}
                  />
                </InlineStack>
                <TextField
                  label="Minimum order amount ($)"
                  type="number"
                  value={formData.minimumOrderAmount}
                  onChange={(value) => handleInputChange("minimumOrderAmount", value)}
                  prefix="$"
                  min={0}
                />
              </BlockStack>
            )}

            {formData.discountMethod === "free_shipping" && (
              <TextField
                label="Minimum order amount for free shipping ($)"
                type="number"
                value={formData.freeShippingMinimumAmount}
                onChange={(value) => handleInputChange("freeShippingMinimumAmount", value)}
                prefix="$"
                min={0}
              />
            )}

            {formData.discountMethod === "buy_x_get_y" && (
              <BlockStack gap="base">
                <InlineStack gap="base">
                  <TextField
                    label="Buy quantity"
                    type="number"
                    value={formData.buyQuantity}
                    onChange={(value) => handleInputChange("buyQuantity", value)}
                    min={1}
                  />
                  <TextField
                    label="Get quantity"
                    type="number"
                    value={formData.getQuantity}
                    onChange={(value) => handleInputChange("getQuantity", value)}
                    min={1}
                  />
                </InlineStack>
                <Select
                  label="Discount type for Y items"
                  options={[
                    { label: "Free", value: "free" },
                    { label: "Percentage off", value: "percentage" },
                    { label: "Amount off", value: "amount" },
                  ]}
                  value={formData.buyXGetYDiscountType}
                  onChange={(value) => handleInputChange("buyXGetYDiscountType", value)}
                />
                {formData.buyXGetYDiscountType !== "free" && (
                  <TextField
                    label={
                      formData.buyXGetYDiscountType === "percentage"
                        ? "Percentage off (%)"
                        : "Amount off ($)"
                    }
                    type="number"
                    value={formData.buyXGetYValue}
                    onChange={(value) => handleInputChange("buyXGetYValue", value)}
                    suffix={formData.buyXGetYDiscountType === "percentage" ? "%" : "$"}
                    min={0}
                    max={formData.buyXGetYDiscountType === "percentage" ? 100 : undefined}
                  />
                )}
              </BlockStack>
            )}

            {/* Schedule */}
            <BlockStack gap="base">
              <Text variant="headingMd">Schedule</Text>
              <InlineStack gap="base">
                <TextField
                  label="Start date and time"
                  type="datetime-local"
                  value={formData.startDateTime}
                  onChange={(value) => handleInputChange("startDateTime", value)}
                />
                <TextField
                  label="End date and time"
                  type="datetime-local"
                  value={formData.endDateTime}
                  onChange={(value) => handleInputChange("endDateTime", value)}
                />
              </InlineStack>
            </BlockStack>

            {/* Usage Limits (code discounts only) */}
            {formData.discountType === "code" && (
              <BlockStack gap="base">
                <Text variant="headingMd">Usage Limits</Text>
                <TextField
                  label="Maximum number of uses"
                  type="number"
                  value={formData.usageLimit}
                  onChange={(value) => handleInputChange("usageLimit", value)}
                  min={0}
                  helpText="Leave empty for unlimited uses"
                />
                <ChoiceList
                  choices={[{ label: "Limit to one use per customer", value: "true" }]}
                  selected={formData.appliesOncePerCustomer ? ["true"] : []}
                  onChange={(selected) =>
                    handleInputChange("appliesOncePerCustomer", selected.includes("true"))
                  }
                />
              </BlockStack>
            )}

            {/* Customer Eligibility */}
            <BlockStack gap="base">
              <Text variant="headingMd">Customer Eligibility</Text>
              <ChoiceList
                title="Who can use this discount?"
                choices={[
                  { label: "All customers", value: "all_customers" },
                  { label: "Specific customer segments", value: "specific_segments" },
                  { label: "Specific customers", value: "specific_customers" },
                ]}
                selected={[formData.eligibilityType]}
                onChange={(selected) => handleInputChange("eligibilityType", selected[0])}
              />

              {formData.eligibilityType === "specific_segments" && (
                <TextField
                  label="Customer segments (comma-separated)"
                  value={formData.customerSegments.join(", ")}
                  onChange={(value) =>
                    handleInputChange(
                      "customerSegments",
                      value.split(",").map((s) => s.trim()).filter(Boolean)
                    )
                  }
                  placeholder="e.g., vip, loyalty, premium"
                  helpText="Enter customer segment names or tags separated by commas"
                />
              )}

              {formData.eligibilityType === "specific_customers" && (
                <>
                  <TextField
                    label="Search customers by email or name"
                    value={customerSearch}
                    onChange={async (value) => {
                      setCustomerSearch(value);
                      const params = new URLSearchParams({ customerSearch: value });
                      const res = await fetch(`?${params.toString()}`);
                      const data = await res.json();
                      setCustomerSearchResults(data.customers || []);
                    }}
                    placeholder="e.g., john@example.com"
                  />
                  <BlockStack gap="xs">
                    {customerSearchResults.map((customer) => (
                      <Checkbox
                        key={customer.id}
                        label={`${customer.firstName || ""} ${customer.lastName || ""} (${customer.email})`}
                        checked={selectedCustomerIds.includes(customer.id)}
                        onChange={(checked) => {
                          setSelectedCustomerIds((prev) =>
                            checked
                              ? [...prev, customer.id]
                              : prev.filter((id) => id !== customer.id)
                          );
                        }}
                      />
                    ))}
                  </BlockStack>
                </>
              )}

              <TextField
                label="Minimum amount spent by customer ($)"
                type="number"
                value={formData.minimumSpent}
                onChange={(value) => handleInputChange("minimumSpent", value)}
                prefix="$"
                min={0}
                helpText="Leave empty for no minimum spent requirement"
              />
            </BlockStack>

            {/* Sales Channel Access */}
            <BlockStack gap="base">
              <Text variant="headingMd">Sales channel access</Text>
              <Button onClick={() => setSalesChannelModalOpen(true)}>
                {formData.selectedSalesChannels.length > 0
                  ? `${formData.selectedSalesChannels.length} channel(s) selected`
                  : "Select sales channels"}
              </Button>
              <Modal
                open={salesChannelModalOpen}
                onClose={() => setSalesChannelModalOpen(false)}
                title="Sales channel access"
                primaryAction={{
                  content: "Done",
                  onAction: () => setSalesChannelModalOpen(false),
                }}
              >
                <Modal.Section>
                  <BlockStack gap="xs">
                    {salesChannels.map((channel) => (
                      <Checkbox
                        key={channel.id}
                        label={channel.name}
                        checked={formData.selectedSalesChannels.includes(channel.id)}
                        onChange={(checked) => {
                          setFormData((prev) => ({
                            ...prev,
                            selectedSalesChannels: checked
                              ? [...prev.selectedSalesChannels, channel.id]
                              : prev.selectedSalesChannels.filter((id) => id !== channel.id),
                          }));
                        }}
                      />
                    ))}
                  </BlockStack>
                </Modal.Section>
              </Modal>
            </BlockStack>

            {/* App Exclusive Toggle */}
            <Checkbox
              label="App Exclusive — only apply to customers shopping via Tapcart"
              checked={formData.appExclusive}
              onChange={(value) => handleInputChange("appExclusive", value)}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
