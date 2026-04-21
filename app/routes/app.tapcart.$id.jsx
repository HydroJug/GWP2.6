import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Banner,
  Button,
  Box,
  ChoiceList,
  Checkbox,
  Tag,
  Spinner,
  Avatar,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Modal,
  Badge,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import DateTimePicker from "../components/DateTimePicker";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const isNew = params.id === "new";

  const fnRes = await admin.graphql(
    `query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`
  );
  const fnData = await fnRes.json();
  const fn = fnData.data?.shopifyFunctions?.nodes?.find(
    (f) => f.apiType === "discount" && f.title === "Tapcart Exclusive Discount Function"
  );
  const functionId = fn?.id ?? null;

  if (isNew) return json({ functionId, discount: null, isNew: true });

  const rawId = params.id;
  let automaticGid, codeGid;
  if (rawId.startsWith("gid://shopify/DiscountAutomaticNode/")) {
    automaticGid = rawId; codeGid = null;
  } else if (rawId.startsWith("gid://shopify/DiscountCodeNode/")) {
    automaticGid = null; codeGid = rawId;
  } else {
    automaticGid = `gid://shopify/DiscountAutomaticNode/${rawId}`;
    codeGid = `gid://shopify/DiscountCodeNode/${rawId}`;
  }

  let d, config;
  if (automaticGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        automaticDiscountNode(id: $id) {
          id
          metafield(namespace: "tapcart", key: "discount_config") { value }
          automaticDiscount {
            ... on DiscountAutomaticApp { discountId title status startsAt endsAt }
          }
        }
      }`,
      { variables: { id: automaticGid } }
    );
    const node = (await res.json()).data?.automaticDiscountNode;
    if (node) { d = { ...node.automaticDiscount, codes: null }; config = node.metafield?.value ? JSON.parse(node.metafield.value) : {}; }
  }
  if (!d && codeGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          metafield(namespace: "tapcart", key: "discount_config") { value }
          codeDiscount {
            ... on DiscountCodeApp {
              discountId title status startsAt endsAt
              usageLimit appliesOncePerCustomer
              codes(first: 1) { edges { node { code } } }
            }
          }
        }
      }`,
      { variables: { id: codeGid } }
    );
    const node = (await res.json()).data?.codeDiscountNode;
    if (node) { d = node.codeDiscount; config = node.metafield?.value ? JSON.parse(node.metafield.value) : {}; }
  }
  if (!d) return json({ functionId, discount: null, isNew: false, notFound: true });

  const isAutomatic = !d.codes;

  return json({
    functionId,
    isNew: false,
    discount: {
      discountId: d.discountId,
      discountType: isAutomatic ? "automatic" : "code",
      title: d.title,
      code: d.codes?.edges?.[0]?.node?.code ?? "",
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      usageLimit: d.usageLimit?.toString() ?? "",
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? false,
      status: d.status,
      config: config || {},
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const isNew = params.id === "new";

  const discountId = formData.get("discountId");
  const discountType = formData.get("discountType") ?? "automatic";
  const code = formData.get("code")?.trim();
  const title = formData.get("title")?.trim();
  const functionId = formData.get("functionId");
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";

  if (!functionId) return json({ error: "Tapcart discount function is not deployed yet." });
  if (!title) return json({ error: "Title is required." });

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;

  // Build function config from form
  const config = {
    discountMethod: formData.get("discountMethod") ?? "amount_off_products",
    productDiscountAmount: formData.get("productDiscountAmount") || "0",
    productDiscountPercentage: formData.get("productDiscountPercentage") || "0",
    orderDiscountAmount: formData.get("orderDiscountAmount") || "0",
    orderDiscountPercentage: formData.get("orderDiscountPercentage") || "0",
    freeShippingMinimumAmount: formData.get("freeShippingMinimumAmount") || "0",
    minimumOrderAmount: formData.get("minimumOrderAmount") || "0",
    buyQuantity: formData.get("buyQuantity") || "1",
    getQuantity: formData.get("getQuantity") || "1",
    buyXGetYDiscountType: formData.get("buyXGetYDiscountType") || "free",
    buyXGetYValue: formData.get("buyXGetYValue") || "0",
    productSelectionType: formData.get("productSelectionType") ?? "all_products",
    selectedProducts: JSON.parse(formData.get("selectedProducts") || "[]"),
    selectedCollections: JSON.parse(formData.get("selectedCollections") || "[]"),
    customerEligibility: formData.get("customerEligibility") ?? "all",
    selectedCustomers: JSON.parse(formData.get("selectedCustomers") || "[]"),
    customerIds: JSON.parse(formData.get("selectedCustomers") || "[]").map((c) => c.id),
    customerTags: JSON.parse(formData.get("customerTags") || "[]"),
    appExclusive: formData.get("appExclusive") !== "false",
    channelKey: "channel",
    channelValue: "tapcart",
  };

  const customerEligibility = config.customerEligibility;
  const customerTags = config.customerTags;

  // Input variables for the function's GraphQL query
  const variables = {
    eligibilityTags: customerEligibility === "specific_tags" ? customerTags : [],
  };

  const discountClasses = ["ORDER", "PRODUCT", "SHIPPING"];
  const configMetafield = { namespace: "tapcart", key: "discount_config", type: "json", value: JSON.stringify(config) };
  const variablesMetafield = { namespace: "tapcart", key: "variables", type: "json", value: JSON.stringify(variables) };
  const metafields = [configMetafield];

  try {
    let createdDiscountId;
    if (!isNew && discountId) {
      if (discountType === "automatic") {
        const res = await admin.graphql(
          `mutation($id: ID!, $d: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { id: discountId, d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, metafields } } }
        );
        const data = await res.json();
        const errors = data.data?.discountAutomaticAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
      } else {
        const res = await admin.graphql(
          `mutation($id: ID!, $d: DiscountCodeAppInput!) {
            discountCodeAppUpdate(id: $id, codeAppDiscount: $d) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { id: discountId, d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer, metafields } } }
        );
        const data = await res.json();
        const errors = data.data?.discountCodeAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId;
      }
    } else {
      if (discountType === "automatic") {
        const res = await admin.graphql(
          `mutation($d: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $d) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, metafields } } }
        );
        const data = await res.json();
        const errors = data.data?.discountAutomaticAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
      } else {
        const res = await admin.graphql(
          `mutation($d: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $d) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { d: { title, code, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer, metafields } } }
        );
        const data = await res.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
      }
    }

    // Save the variables metafield on the discount node
    const resolvedDiscountId = createdDiscountId || discountId;
    if (resolvedDiscountId) {
      const nodeId = resolvedDiscountId
        .replace("DiscountAutomaticApp", "DiscountAutomaticNode")
        .replace("DiscountCodeApp", "DiscountCodeNode");
      console.log(`[TapcartDiscount] Saving variables metafield on ${nodeId}:`, JSON.stringify(variables));
      const mfRes = await admin.graphql(
        `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { namespace key }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              { ownerId: nodeId, ...variablesMetafield },
            ],
          },
        }
      );
      const mfData = await mfRes.json();
      console.log(`[TapcartDiscount] Variables metafield result:`, JSON.stringify(mfData.data?.metafieldsSet?.userErrors));
    } else {
      console.log(`[TapcartDiscount] WARNING: No discount ID available to save variables metafield`);
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildEmpty() {
  return {
    discountType: ["automatic"],
    code: "",
    title: "",
    startDateTime: nowLocal(),
    endDateTime: "",
    usageLimit: "",
    appliesOncePerCustomer: false,
    discountMethod: ["amount_off_products"],
    productValueType: ["percentage"],
    productDiscountValue: "",
    orderValueType: ["percentage"],
    orderDiscountValue: "",
    minimumOrderAmount: "",
    freeShippingMinimumAmount: "",
    buyQuantity: "1",
    getQuantity: "1",
    buyXGetYDiscountType: ["free"],
    buyXGetYValue: "",
    productSelectionType: ["all_products"],
    selectedProducts: [],
    selectedCollections: [],
    customerEligibility: ["all"],
    selectedCustomers: [],
    customerTags: [],
    appExclusive: true,
  };
}

function buildFromDiscount(d) {
  const c = d.config || {};
  return {
    discountType: [d.discountType],
    code: d.code,
    title: d.title,
    startDateTime: d.startsAt,
    endDateTime: d.endsAt,
    usageLimit: d.usageLimit,
    appliesOncePerCustomer: d.appliesOncePerCustomer,
    discountMethod: [c.discountMethod || "amount_off_products"],
    productValueType: [c.productDiscountPercentage && parseFloat(c.productDiscountPercentage) > 0 ? "percentage" : c.productDiscountAmount && parseFloat(c.productDiscountAmount) > 0 ? "amount" : "percentage"],
    productDiscountValue: c.productDiscountPercentage && parseFloat(c.productDiscountPercentage) > 0 ? c.productDiscountPercentage : c.productDiscountAmount || "",
    orderValueType: [c.orderDiscountPercentage && parseFloat(c.orderDiscountPercentage) > 0 ? "percentage" : c.orderDiscountAmount && parseFloat(c.orderDiscountAmount) > 0 ? "amount" : "percentage"],
    orderDiscountValue: c.orderDiscountPercentage && parseFloat(c.orderDiscountPercentage) > 0 ? c.orderDiscountPercentage : c.orderDiscountAmount || "",
    minimumOrderAmount: c.minimumOrderAmount || "",
    freeShippingMinimumAmount: c.freeShippingMinimumAmount || "",
    buyQuantity: c.buyQuantity?.toString() || "1",
    getQuantity: c.getQuantity?.toString() || "1",
    buyXGetYDiscountType: [c.buyXGetYDiscountType || "free"],
    buyXGetYValue: c.buyXGetYValue?.toString() || "",
    productSelectionType: [c.productSelectionType || "all_products"],
    selectedProducts: c.selectedProducts || [],
    selectedCollections: c.selectedCollections || [],
    customerEligibility: [c.customerEligibility || "all"],
    selectedCustomers: c.selectedCustomers || [],
    customerTags: c.customerTags || [],
    appExclusive: c.appExclusive !== false,
  };
}

function useCustomerSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search-customers?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data.customers ?? []);
      } catch { setResults([]); }
      setLoading(false);
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  return { query, setQuery, results, loading };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TapcartForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;

  const [form, setForm] = useState(() => isEditing ? buildFromDiscount(discount) : buildEmpty());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);
  const customerSearch = useCustomerSearch();
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    const trimmed = tagInput.trim();
    if (!trimmed) return;
    if (form.customerTags.includes(trimmed)) { setTagInput(""); return; }
    set("customerTags", [...form.customerTags, trimmed]);
    setTagInput("");
  };

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      shopify.toast.show(isEditing ? "Discount updated!" : "Discount created!");
      if (!isEditing) setForm(buildEmpty());
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing]);

  // ── Pickers ─────────────────────────────────────────────────────────────

  const openProductPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: form.selectedProducts.map((p) => ({ id: p.id })),
    });
    if (selected) {
      set("selectedProducts", selected.map((p) => ({ id: p.id, title: p.title, image: p.images?.[0]?.originalSrc ?? null })));
    }
  }, [shopify, form.selectedProducts, set]);

  const openCollectionPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: form.selectedCollections.map((c) => ({ id: c.id })),
    });
    if (selected) {
      set("selectedCollections", selected.map((c) => ({ id: c.id, title: c.title, image: c.image?.originalSrc ?? null })));
    }
  }, [shopify, form.selectedCollections, set]);

  const addCustomer = useCallback((customer) => {
    if (form.selectedCustomers.some((c) => c.id === customer.id)) return;
    set("selectedCustomers", [...form.selectedCustomers, { id: customer.id, displayName: customer.displayName, email: customer.email }]);
    customerSearch.setQuery("");
  }, [form.selectedCustomers, set, customerSearch]);

  const removeCustomer = useCallback(
    (id) => set("selectedCustomers", form.selectedCustomers.filter((c) => c.id !== id)),
    [form.selectedCustomers, set]
  );

  // ── Modal state for customer eligibility ───────────────────────────────
  const [customerModalOpen, setCustomerModalOpen] = useState(false);

  // ── Submit ──────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(() => {
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (form.discountType[0] === "code" && !form.code.trim()) { shopify.toast.show("Discount code is required.", { isError: true }); return; }
    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("discountType", form.discountType[0]);
    data.append("code", form.code);
    data.append("title", form.title);
    data.append("functionId", functionId ?? "");
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("discountMethod", form.discountMethod[0]);
    data.append("productDiscountAmount", form.productValueType[0] === "amount" ? form.productDiscountValue : "0");
    data.append("productDiscountPercentage", form.productValueType[0] === "percentage" ? form.productDiscountValue : "0");
    data.append("orderDiscountAmount", form.orderValueType[0] === "amount" ? form.orderDiscountValue : "0");
    data.append("orderDiscountPercentage", form.orderValueType[0] === "percentage" ? form.orderDiscountValue : "0");
    data.append("minimumOrderAmount", form.minimumOrderAmount);
    data.append("freeShippingMinimumAmount", form.freeShippingMinimumAmount);
    data.append("buyQuantity", form.buyQuantity);
    data.append("getQuantity", form.getQuantity);
    data.append("buyXGetYDiscountType", form.buyXGetYDiscountType[0]);
    data.append("buyXGetYValue", form.buyXGetYValue);
    data.append("productSelectionType", form.productSelectionType[0]);
    data.append("selectedProducts", JSON.stringify(form.selectedProducts));
    data.append("selectedCollections", JSON.stringify(form.selectedCollections));
    data.append("customerEligibility", form.customerEligibility[0]);
    data.append("selectedCustomers", JSON.stringify(form.selectedCustomers));
    data.append("customerTags", JSON.stringify(form.customerTags));
    data.append("appExclusive", String(form.appExclusive));
    fetcher.submit(data, { method: "POST" });
  }, [form, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) return (
    <Page backAction={{ content: "Tapcart Discounts", url: "/app/tapcart" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  const pageTitle = isEditing ? "Edit Tapcart Discount" : "Create Tapcart Discount";
  const method = form.discountMethod[0];

  return (
    <Page backAction={{ content: "Tapcart Discounts", url: "/app/tapcart" }} title={pageTitle}
      primaryAction={{ content: "Save", onAction: handleSubmit, loading: isSubmitting, disabled: isSubmitting || !functionId }}>
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Tapcart discount function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {fetcher.data?.error && <Banner tone="critical"><p>{fetcher.data.error}</p></Banner>}

            <Banner tone="info" title="Tapcart setup required">
              <BlockStack gap="200">
                <Text variant="bodyMd">For this discount to work, Tapcart must add a cart attribute to identify app users. Contact your Tapcart account team and ask them to:</Text>
                <Text variant="bodyMd">1. Add a cart attribute with key <strong>channel</strong> and value <strong>tapcart</strong> on every cart created in the Tapcart app.</Text>
                <Text variant="bodyMd">Once this is configured, any discount created here with "App Exclusive" enabled will only apply to customers shopping through Tapcart.</Text>
              </BlockStack>
            </Banner>

            {/* ── Discount details ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount details</Text>
                <ChoiceList title="Discount type" choices={[{ label: "Automatic discount", value: "automatic" }, { label: "Discount code", value: "code" }]} selected={form.discountType} onChange={(v) => set("discountType", v)} />
                {form.discountType[0] === "code" && (
                  <TextField label="Discount code" value={form.code} onChange={(v) => set("code", v)} placeholder="e.g., TAPCART10" autoComplete="off" />
                )}
                <TextField label="Title" value={form.title} onChange={(v) => set("title", v)} placeholder="e.g., Tapcart App Exclusive - 10% Off" autoComplete="off" />
                <Checkbox label="App Exclusive — only apply to customers shopping via Tapcart" checked={form.appExclusive} onChange={(v) => set("appExclusive", v)} />
              </BlockStack>
            </Card>

            {/* ── Discount method ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount method</Text>
                <ChoiceList
                  title="Method"
                  choices={[
                    { label: "Amount off products", value: "amount_off_products" },
                    { label: "Amount off order", value: "amount_off_order" },
                    { label: "Buy X get Y", value: "buy_x_get_y" },
                    { label: "Free shipping", value: "free_shipping" },
                  ]}
                  selected={form.discountMethod}
                  onChange={(v) => set("discountMethod", v)}
                />

                {method === "amount_off_products" && (
                  <BlockStack gap="300">
                    <ChoiceList
                      title="Value type"
                      choices={[
                        { label: "Percentage off", value: "percentage" },
                        { label: "Fixed amount off", value: "amount" },
                      ]}
                      selected={form.productValueType}
                      onChange={(v) => set("productValueType", v)}
                    />
                    <Box maxWidth="200px">
                      <TextField
                        label={form.productValueType[0] === "percentage" ? "Percentage off (%)" : "Amount off ($)"}
                        type="number"
                        value={form.productDiscountValue}
                        onChange={(v) => set("productDiscountValue", v)}
                        prefix={form.productValueType[0] === "amount" ? "$" : undefined}
                        suffix={form.productValueType[0] === "percentage" ? "%" : undefined}
                        min={0}
                        max={form.productValueType[0] === "percentage" ? 100 : undefined}
                        autoComplete="off"
                      />
                    </Box>
                  </BlockStack>
                )}

                {method === "amount_off_order" && (
                  <BlockStack gap="300">
                    <ChoiceList
                      title="Value type"
                      choices={[
                        { label: "Percentage off", value: "percentage" },
                        { label: "Fixed amount off", value: "amount" },
                      ]}
                      selected={form.orderValueType}
                      onChange={(v) => set("orderValueType", v)}
                    />
                    <Box maxWidth="200px">
                      <TextField
                        label={form.orderValueType[0] === "percentage" ? "Percentage off (%)" : "Amount off ($)"}
                        type="number"
                        value={form.orderDiscountValue}
                        onChange={(v) => set("orderDiscountValue", v)}
                        prefix={form.orderValueType[0] === "amount" ? "$" : undefined}
                        suffix={form.orderValueType[0] === "percentage" ? "%" : undefined}
                        min={0}
                        max={form.orderValueType[0] === "percentage" ? 100 : undefined}
                        autoComplete="off"
                      />
                    </Box>
                    <TextField label="Minimum order amount ($)" type="number" value={form.minimumOrderAmount} onChange={(v) => set("minimumOrderAmount", v)} prefix="$" min={0} helpText="Leave empty for no minimum" autoComplete="off" />
                  </BlockStack>
                )}

                {method === "buy_x_get_y" && (
                  <BlockStack gap="300">
                    <InlineStack gap="400" wrap>
                      <Box minWidth="120px"><TextField label="Buy quantity" type="number" value={form.buyQuantity} onChange={(v) => set("buyQuantity", v)} min={1} autoComplete="off" /></Box>
                      <Box minWidth="120px"><TextField label="Get quantity" type="number" value={form.getQuantity} onChange={(v) => set("getQuantity", v)} min={1} autoComplete="off" /></Box>
                    </InlineStack>
                    <ChoiceList title="Discount for Y items" choices={[{ label: "Free", value: "free" }, { label: "Percentage off", value: "percentage" }, { label: "Amount off", value: "amount" }]} selected={form.buyXGetYDiscountType} onChange={(v) => set("buyXGetYDiscountType", v)} />
                    {form.buyXGetYDiscountType[0] !== "free" && (
                      <Box maxWidth="200px">
                        <TextField label={form.buyXGetYDiscountType[0] === "percentage" ? "Percentage off (%)" : "Amount off ($)"} type="number" value={form.buyXGetYValue} onChange={(v) => set("buyXGetYValue", v)} prefix={form.buyXGetYDiscountType[0] === "amount" ? "$" : undefined} suffix={form.buyXGetYDiscountType[0] === "percentage" ? "%" : undefined} min={0} autoComplete="off" />
                      </Box>
                    )}
                  </BlockStack>
                )}

                {method === "free_shipping" && (
                  <TextField label="Minimum order amount for free shipping ($)" type="number" value={form.freeShippingMinimumAmount} onChange={(v) => set("freeShippingMinimumAmount", v)} prefix="$" min={0} helpText="Leave empty or 0 for no minimum" autoComplete="off" />
                )}
              </BlockStack>
            </Card>

            {/* ── Product selection ── */}
            {(method === "amount_off_products" || method === "buy_x_get_y") && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Applies to</Text>
                  <ChoiceList
                    title="Product selection"
                    choices={[
                      { label: "All products", value: "all_products" },
                      { label: "Specific collections", value: "collections" },
                      { label: "Specific products", value: "specific_products" },
                    ]}
                    selected={form.productSelectionType}
                    onChange={(v) => set("productSelectionType", v)}
                  />

                  {form.productSelectionType[0] === "collections" && (
                    <BlockStack gap="300">
                      <Button onClick={openCollectionPicker}>
                        {form.selectedCollections.length ? "Edit collections" : "Browse collections"}
                      </Button>
                      {form.selectedCollections.length > 0 && (
                        <InlineStack gap="200" wrap>
                          {form.selectedCollections.map((c) => (
                            <Tag key={c.id} onRemove={() => set("selectedCollections", form.selectedCollections.filter((x) => x.id !== c.id))}>{c.title}</Tag>
                          ))}
                        </InlineStack>
                      )}
                    </BlockStack>
                  )}

                  {form.productSelectionType[0] === "specific_products" && (
                    <BlockStack gap="300">
                      <Button onClick={openProductPicker}>
                        {form.selectedProducts.length ? "Edit products" : "Browse products"}
                      </Button>
                      {form.selectedProducts.length > 0 && (
                        <ResourceList
                          resourceName={{ singular: "product", plural: "products" }}
                          items={form.selectedProducts}
                          renderItem={(item) => (
                            <ResourceItem
                              id={item.id}
                              media={<Thumbnail source={item.image || ImageIcon} alt={item.title} size="small" />}
                              shortcutActions={[{ content: "Remove", onAction: () => set("selectedProducts", form.selectedProducts.filter((p) => p.id !== item.id)) }]}
                            >
                              <Text variant="bodyMd" fontWeight="semibold">{item.title}</Text>
                            </ResourceItem>
                          )}
                        />
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* ── Customer eligibility ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Customer eligibility</Text>
                <ChoiceList
                  title="Who can use this discount"
                  choices={[
                    { label: "All customers", value: "all" },
                    { label: "Customers with specific tags", value: "specific_tags" },
                    { label: "Specific customers", value: "specific_customers" },
                  ]}
                  selected={form.customerEligibility}
                  onChange={(v) => set("customerEligibility", v)}
                />

                {form.customerEligibility[0] === "specific_tags" && (
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="end">
                      <Box minWidth="260px">
                        <TextField
                          label="Customer tag"
                          value={tagInput}
                          onChange={setTagInput}
                          placeholder="e.g., VIP"
                          autoComplete="off"
                          helpText="Discount applies to customers who have ANY of these tags. Manage tags in Shopify Admin, Flow, or via CSV."
                          onBlur={addTag}
                          connectedRight={<Button onClick={addTag}>Add</Button>}
                        />
                      </Box>
                    </InlineStack>
                    {form.customerTags.length > 0 && (
                      <InlineStack gap="200" wrap>
                        {form.customerTags.map((t) => (
                          <Tag key={t} onRemove={() => set("customerTags", form.customerTags.filter((x) => x !== t))}>
                            {t}
                          </Tag>
                        ))}
                      </InlineStack>
                    )}
                  </BlockStack>
                )}

                {form.customerEligibility[0] === "specific_customers" && (
                  <BlockStack gap="300">
                    <Button onClick={() => { customerSearch.setQuery(""); setCustomerModalOpen(true); }}>
                      {form.selectedCustomers.length ? "Edit customers" : "Browse customers"}
                    </Button>
                    {form.selectedCustomers.length > 0 && (
                      <InlineStack gap="200" wrap>
                        {form.selectedCustomers.map((c) => (
                          <Tag key={c.id} onRemove={() => removeCustomer(c.id)}>
                            {c.displayName}{c.email ? ` (${c.email})` : ""}
                          </Tag>
                        ))}
                      </InlineStack>
                    )}

                    <Modal
                      open={customerModalOpen}
                      onClose={() => setCustomerModalOpen(false)}
                      title="Select customers"
                      primaryAction={{ content: "Done", onAction: () => setCustomerModalOpen(false) }}
                    >
                      <Modal.Section>
                        <BlockStack gap="400">
                          <TextField
                            label="Search customers"
                            value={customerSearch.query}
                            onChange={customerSearch.setQuery}
                            placeholder="Search by name or email"
                            autoComplete="off"
                            suffix={customerSearch.loading ? <Spinner size="small" /> : null}
                          />
                          {customerSearch.results.length > 0 && (
                            <ResourceList
                              resourceName={{ singular: "customer", plural: "customers" }}
                              items={customerSearch.results}
                              renderItem={(c) => {
                                const alreadySelected = form.selectedCustomers.some((x) => x.id === c.id);
                                return (
                                  <ResourceItem
                                    id={c.id}
                                    media={<Avatar size="sm" name={c.displayName} />}
                                    onClick={() => {
                                      if (!alreadySelected) addCustomer(c);
                                    }}
                                  >
                                    <InlineStack gap="200" blockAlign="center">
                                      <Text variant="bodyMd" fontWeight="semibold">{c.displayName}</Text>
                                      {c.email && <Text variant="bodySm" tone="subdued">{c.email}</Text>}
                                      {alreadySelected && <Badge tone="success">Added</Badge>}
                                    </InlineStack>
                                  </ResourceItem>
                                );
                              }}
                            />
                          )}
                          {form.selectedCustomers.length > 0 && (
                            <>
                              <Text variant="headingSm">Selected</Text>
                              <InlineStack gap="200" wrap>
                                {form.selectedCustomers.map((c) => (
                                  <Tag key={c.id} onRemove={() => removeCustomer(c.id)}>
                                    {c.displayName}{c.email ? ` (${c.email})` : ""}
                                  </Tag>
                                ))}
                              </InlineStack>
                            </>
                          )}
                        </BlockStack>
                      </Modal.Section>
                    </Modal>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* ── Schedule ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px"><DateTimePicker label="Start date" value={form.startDateTime} onChange={(v) => set("startDateTime", v)} /></Box>
                  <Box minWidth="300px"><DateTimePicker label="End date (optional)" value={form.endDateTime} onChange={(v) => set("endDateTime", v)} helpText="Leave empty for no end date" /></Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Usage limits (code only) ── */}
            {form.discountType[0] === "code" && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Usage limits</Text>
                  <TextField label="Maximum number of uses (optional)" type="number" value={form.usageLimit} onChange={(v) => set("usageLimit", v)} min={0} helpText="Leave empty for unlimited" autoComplete="off" />
                  <Checkbox label="Limit to one use per customer" checked={form.appliesOncePerCustomer} onChange={(v) => set("appliesOncePerCustomer", v)} />
                </BlockStack>
              </Card>
            )}

            {/* ── Summary ── */}
            {isEditing && discount?.status && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Summary</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" tone="subdued">Status</Text>
                    <Badge tone={discount.status === "ACTIVE" ? "success" : "default"}>
                      {discount.status.charAt(0) + discount.status.slice(1).toLowerCase()}
                    </Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            <InlineStack align="end">
              <Button variant="primary" onClick={handleSubmit} loading={isSubmitting} disabled={isSubmitting || !functionId}>
                {isEditing ? "Save changes" : "Create discount"}
              </Button>
            </InlineStack>

            <Box paddingBlockEnd="1000" />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
