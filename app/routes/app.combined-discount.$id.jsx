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
  Icon,
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
    (f) => f.apiType === "discount" && f.title === "Combined Discount"
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
          metafield(namespace: "combined_discount", key: "config") { value }
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
          metafield(namespace: "combined_discount", key: "config") { value }
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
      discountValueType: config.discountValueType ?? "percentage",
      discountValue: config.discountValue ?? "",
      minimumOrderAmount: config.minimumOrderAmount ?? "",
      includesFreeShipping: config.includesFreeShipping ?? false,
      freeShippingMinimum: config.freeShippingMinimum ?? "",
      maxShippingCost: config.maxShippingCost ?? "",
      discountScope: config.discountScope ?? "order",
      appliesTo: config.appliesTo ?? "all",
      selectedProducts: config.selectedProducts ?? [],
      selectedCollections: config.selectedCollections ?? [],
      maxApplicationsPerOrder: config.maxApplicationsPerOrder ?? "",
      customerEligibility: config.customerEligibility ?? "all",
      selectedCustomers: config.selectedCustomers ?? [],
      customerTags: config.customerTags ?? [],
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const isNew = params.id === "new";

  const discountId = formData.get("discountId");
  const discountType = formData.get("discountType") ?? "code";
  const code = formData.get("code")?.trim();
  const title = formData.get("title")?.trim();
  const discountValueType = formData.get("discountValueType");
  const discountValue = formData.get("discountValue");
  const minimumOrderAmount = formData.get("minimumOrderAmount");
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const includesFreeShipping = formData.get("includesFreeShipping") === "true";
  const freeShippingMinimum = formData.get("freeShippingMinimum");
  const maxShippingCost = formData.get("maxShippingCost");
  const functionId = formData.get("functionId");
  const discountScope = formData.get("discountScope") ?? "order";
  const appliesTo = formData.get("appliesTo") ?? "all";
  const selectedProducts = JSON.parse(formData.get("selectedProducts") || "[]");
  const selectedCollections = JSON.parse(formData.get("selectedCollections") || "[]");
  const maxApplicationsPerOrder = formData.get("maxApplicationsPerOrder") || "";
  const customerEligibility = formData.get("customerEligibility") ?? "all";
  const selectedCustomers = JSON.parse(formData.get("selectedCustomers") || "[]");
  const customerTags = JSON.parse(formData.get("customerTags") || "[]");

  if (!functionId) return json({ error: "Combined Discount function is not deployed yet." });

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;

  const config = {
    discountValueType,
    discountValue,
    minimumOrderAmount: minimumOrderAmount || null,
    includesFreeShipping,
    freeShippingMinimum: freeShippingMinimum || null,
    maxShippingCost: maxShippingCost || null,
    discountScope,
    appliesTo,
    productIds: selectedProducts.map((p) => p.id),
    selectedProducts,
    collectionIds: selectedCollections.map((c) => c.id),
    selectedCollections,
    maxApplicationsPerOrder: maxApplicationsPerOrder || null,
    customerEligibility,
    customerIds: selectedCustomers.map((c) => c.id),
    selectedCustomers,
    customerTags,
  };

  // Input variables for the function's GraphQL query
  const variables = {
    collectionIds: appliesTo === "collections" ? selectedCollections.map((c) => c.id) : [],
    eligibilityTags: customerEligibility === "specific_tags" ? customerTags : [],
  };

  const configMetafield = { namespace: "combined_discount", key: "config", type: "json", value: JSON.stringify(config) };
  const variablesMetafield = { namespace: "combined_discount", key: "variables", type: "json", value: JSON.stringify(variables) };

  // Determine discount classes based on scope
  const discountClasses = ["ORDER", "SHIPPING"];
  if (discountScope === "product") {
    discountClasses.push("PRODUCT");
  }

  const metafields = [configMetafield];

  try {
    let createdDiscountId;
    if (!isNew && discountId) {
      if (discountType === "automatic") {
        const response = await admin.graphql(
          `mutation($id: ID!, $d: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { id: discountId, d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, metafields } } }
        );
        const data = await response.json();
        const errors = data.data?.discountAutomaticAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
      } else {
        const response = await admin.graphql(
          `mutation($id: ID!, $d: DiscountCodeAppInput!) {
            discountCodeAppUpdate(id: $id, codeAppDiscount: $d) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { id: discountId, d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer, metafields } } }
        );
        const data = await response.json();
        const errors = data.data?.discountCodeAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId;
      }
    } else {
      if (discountType === "automatic") {
        const response = await admin.graphql(
          `mutation($d: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $d) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { d: { title, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, metafields } } }
        );
        const data = await response.json();
        const errors = data.data?.discountAutomaticAppCreate?.userErrors ?? [];
        console.log("[CombinedDiscount] Create automatic response:", JSON.stringify(data));
        if (errors.length) return json({ error: errors.map(e => `${e.field}: ${e.message}`).join("; ") });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
      } else {
        const response = await admin.graphql(
          `mutation($d: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $d) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { d: { title, code, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer, metafields } } }
        );
        const data = await response.json();
        console.log("[CombinedDiscount] Create code response:", JSON.stringify(data));
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors.map(e => `${e.field}: ${e.message}`).join("; ") });
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
      console.log(`[CombinedDiscount] Saving variables metafield on ${nodeId}:`, JSON.stringify(variables));
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
      console.log(`[CombinedDiscount] Variables metafield result:`, JSON.stringify(mfData.data?.metafieldsSet?.userErrors));
    } else {
      console.log(`[CombinedDiscount] WARNING: No discount ID available to save variables metafield`);
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message });
  }
};

// ── Page ──────────────────────────────────────────────────────────────────────

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildEmpty() {
  return {
    discountType: ["code"],
    code: "",
    title: "",
    discountValueType: ["percentage"],
    discountValue: "",
    minimumOrderAmount: "",
    startDateTime: nowLocal(),
    endDateTime: "",
    usageLimit: "",
    appliesOncePerCustomer: false,
    includesFreeShipping: false,
    freeShippingMinimum: "",
    maxShippingCost: "",
    discountScope: ["order"],
    appliesTo: ["all"],
    selectedProducts: [],
    selectedCollections: [],
    maxApplicationsPerOrder: "",
    customerEligibility: ["all"],
    selectedCustomers: [],
    customerTags: [],
  };
}

function buildFromDiscount(d) {
  return {
    discountType: [d.discountType],
    code: d.code,
    title: d.title,
    discountValueType: [d.discountValueType || "percentage"],
    discountValue: d.discountValue || "",
    minimumOrderAmount: d.minimumOrderAmount || "",
    startDateTime: d.startsAt,
    endDateTime: d.endsAt,
    usageLimit: d.usageLimit,
    appliesOncePerCustomer: d.appliesOncePerCustomer,
    includesFreeShipping: d.includesFreeShipping,
    freeShippingMinimum: d.freeShippingMinimum || "",
    maxShippingCost: d.maxShippingCost || "",
    discountScope: [d.discountScope || "order"],
    appliesTo: [d.appliesTo || "all"],
    selectedProducts: d.selectedProducts || [],
    selectedCollections: d.selectedCollections || [],
    maxApplicationsPerOrder: d.maxApplicationsPerOrder ?? "",
    customerEligibility: [d.customerEligibility || "all"],
    selectedCustomers: d.selectedCustomers || [],
    customerTags: d.customerTags || [],
  };
}

// ── Customer search hook ────────────────────────────────────────────────────

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
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  return { query, setQuery, results, loading };
}

// ── Customer eligibility card (modal-based pickers) ─────────────────────────

function CustomerEligibilityCard({ form, set, customerSearch, addCustomer, removeCustomer }) {
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    const trimmed = tagInput.trim();
    if (!trimmed) return;
    if (form.customerTags.includes(trimmed)) { setTagInput(""); return; }
    set("customerTags", [...form.customerTags, trimmed]);
    setTagInput("");
  };

  return (
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
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CombinedDiscountForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;

  const [form, setForm] = useState(() => isEditing ? buildFromDiscount(discount) : buildEmpty());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);
  const customerSearch = useCustomerSearch();

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

  // ── Resource pickers ────────────────────────────────────────────────────

  const openProductPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: form.selectedProducts.map((p) => ({ id: p.id })),
    });
    if (selected) {
      set(
        "selectedProducts",
        selected.map((p) => ({
          id: p.id,
          title: p.title,
          image: p.images?.[0]?.originalSrc ?? null,
        }))
      );
    }
  }, [shopify, form.selectedProducts, set]);

  const openCollectionPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: form.selectedCollections.map((c) => ({ id: c.id })),
    });
    if (selected) {
      set(
        "selectedCollections",
        selected.map((c) => ({
          id: c.id,
          title: c.title,
          image: c.image?.originalSrc ?? null,
        }))
      );
    }
  }, [shopify, form.selectedCollections, set]);

  const addCustomer = useCallback(
    (customer) => {
      if (form.selectedCustomers.some((c) => c.id === customer.id)) return;
      set("selectedCustomers", [
        ...form.selectedCustomers,
        { id: customer.id, displayName: customer.displayName, email: customer.email },
      ]);
      customerSearch.setQuery("");
    },
    [form.selectedCustomers, set, customerSearch]
  );

  const removeCustomer = useCallback(
    (id) => set("selectedCustomers", form.selectedCustomers.filter((c) => c.id !== id)),
    [form.selectedCustomers, set]
  );

  const removeProduct = useCallback(
    (id) => set("selectedProducts", form.selectedProducts.filter((p) => p.id !== id)),
    [form.selectedProducts, set]
  );

  const removeCollection = useCallback(
    (id) => set("selectedCollections", form.selectedCollections.filter((c) => c.id !== id)),
    [form.selectedCollections, set]
  );

  // ── Submit ──────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(() => {
    if (form.discountType[0] === "code" && !form.code.trim()) { shopify.toast.show("Discount code is required.", { isError: true }); return; }
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (!form.discountValue || parseFloat(form.discountValue) <= 0) { shopify.toast.show("Enter a discount value greater than 0.", { isError: true }); return; }
    if (form.discountValueType[0] === "percentage" && parseFloat(form.discountValue) > 100) { shopify.toast.show("Percentage cannot exceed 100%.", { isError: true }); return; }
    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("discountType", form.discountType[0]);
    data.append("code", form.code);
    data.append("title", form.title);
    data.append("discountValueType", form.discountValueType[0]);
    data.append("discountValue", form.discountValue);
    data.append("minimumOrderAmount", form.minimumOrderAmount);
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("includesFreeShipping", String(form.includesFreeShipping));
    data.append("freeShippingMinimum", form.freeShippingMinimum);
    data.append("maxShippingCost", form.maxShippingCost);
    data.append("functionId", functionId ?? "");
    data.append("discountScope", form.discountScope[0]);
    data.append("appliesTo", form.appliesTo[0]);
    data.append("selectedProducts", JSON.stringify(form.selectedProducts));
    data.append("selectedCollections", JSON.stringify(form.selectedCollections));
    data.append("maxApplicationsPerOrder", form.maxApplicationsPerOrder);
    data.append("customerEligibility", form.customerEligibility[0]);
    data.append("selectedCustomers", JSON.stringify(form.selectedCustomers));
    data.append("customerTags", JSON.stringify(form.customerTags));
    fetcher.submit(data, { method: "POST" });
  }, [form, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) return (
    <Page backAction={{ content: "All discounts", url: "/app/combined-discount" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  const valueLabel = form.discountValueType[0] === "percentage" ? "Percentage off (%)" : "Fixed amount off ($)";
  const pageTitle = isEditing ? "Edit discount" : "Create discount";
  const isProductScope = form.discountScope[0] === "product";

  return (
    <Page backAction={{ content: "All discounts", url: "/app/combined-discount" }} title={pageTitle}>
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Combined Discount function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* ── Discount details ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount details</Text>
                <ChoiceList title="Discount type" choices={[{ label: "Discount code", value: "code" }, { label: "Automatic discount", value: "automatic" }]} selected={form.discountType} onChange={(v) => set("discountType", v)} />
                {form.discountType[0] === "code" && (
                  <TextField label="Discount code" value={form.code} onChange={(v) => set("code", v)} placeholder="e.g., SUMMER10" helpText="Customers enter this at checkout" autoComplete="off" />
                )}
                <TextField label="Title" value={form.title} onChange={(v) => set("title", v)} placeholder="e.g., Summer Sale 10% Off" helpText="Internal name shown in your discounts list" autoComplete="off" />
              </BlockStack>
            </Card>

            {/* ── Discount value ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount value</Text>
                <ChoiceList title="Value type" choices={[{ label: "Percentage off", value: "percentage" }, { label: "Fixed amount off", value: "amount" }]} selected={form.discountValueType} onChange={(v) => set("discountValueType", v)} />
                <Box maxWidth="200px">
                  <TextField label={valueLabel} type="number" value={form.discountValue} onChange={(v) => set("discountValue", v)} prefix={form.discountValueType[0] === "amount" ? "$" : undefined} suffix={form.discountValueType[0] === "percentage" ? "%" : undefined} min={0} max={form.discountValueType[0] === "percentage" ? 100 : undefined} autoComplete="off" />
                </Box>
                <TextField label="Minimum order subtotal (optional)" type="number" value={form.minimumOrderAmount} onChange={(v) => set("minimumOrderAmount", v)} prefix="$" min={0} helpText="Leave empty for no minimum" autoComplete="off" />
              </BlockStack>
            </Card>

            {/* ── Discount scope ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Applies to</Text>
                <ChoiceList
                  title="Discount scope"
                  choices={[
                    { label: "Entire order", value: "order" },
                    { label: "Specific products", value: "product" },
                  ]}
                  selected={form.discountScope}
                  onChange={(v) => {
                    set("discountScope", v);
                    if (v[0] === "order") set("appliesTo", ["all"]);
                  }}
                />
                {isProductScope && (
                  <BlockStack gap="400">
                    <ChoiceList
                      title="Product selection"
                      choices={[
                        { label: "All products", value: "all" },
                        { label: "Specific collections", value: "collections" },
                        { label: "Specific products", value: "products" },
                      ]}
                      selected={form.appliesTo}
                      onChange={(v) => set("appliesTo", v)}
                    />

                    {form.appliesTo[0] === "collections" && (
                      <BlockStack gap="300">
                        <Button onClick={openCollectionPicker}>
                          {form.selectedCollections.length ? "Edit collections" : "Browse collections"}
                        </Button>
                        {form.selectedCollections.length > 0 && (
                          <InlineStack gap="200" wrap>
                            {form.selectedCollections.map((c) => (
                              <Tag key={c.id} onRemove={() => removeCollection(c.id)}>{c.title}</Tag>
                            ))}
                          </InlineStack>
                        )}
                      </BlockStack>
                    )}

                    {form.appliesTo[0] === "products" && (
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
                                media={
                                  <Thumbnail
                                    source={item.image || ImageIcon}
                                    alt={item.title}
                                    size="small"
                                  />
                                }
                                shortcutActions={[{ content: "Remove", onAction: () => removeProduct(item.id) }]}
                              >
                                <Text variant="bodyMd" fontWeight="semibold">{item.title}</Text>
                              </ResourceItem>
                            )}
                          />
                        )}
                      </BlockStack>
                    )}
                    <TextField
                      label="Max items discounted per order (optional)"
                      type="number"
                      value={form.maxApplicationsPerOrder}
                      onChange={(v) => set("maxApplicationsPerOrder", v)}
                      min={1}
                      helpText="Leave empty to discount all qualifying items."
                      autoComplete="off"
                    />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* ── Customer eligibility ── */}
            <CustomerEligibilityCard
              form={form}
              set={set}
              customerSearch={customerSearch}
              addCustomer={addCustomer}
              removeCustomer={removeCustomer}
            />

            {/* ── Free shipping ── */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Free shipping</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">Bundle free shipping so customers only need one code.</Text>
                </BlockStack>
                <Checkbox label="Include free shipping with this discount" checked={form.includesFreeShipping} onChange={(v) => set("includesFreeShipping", v)} />
                {form.includesFreeShipping && (
                  <BlockStack gap="300">
                    <TextField label="Minimum order for free shipping (optional)" type="number" value={form.freeShippingMinimum} onChange={(v) => set("freeShippingMinimum", v)} prefix="$" min={0} helpText={form.minimumOrderAmount ? `Leave empty to use discount minimum ($${form.minimumOrderAmount})` : "Leave empty for no minimum"} autoComplete="off" />
                    <TextField label="Maximum shipping rate to make free (optional)" type="number" value={form.maxShippingCost} onChange={(v) => set("maxShippingCost", v)} prefix="$" min={0} helpText="Only rates at or below this amount will be made free. Leave empty for all rates." autoComplete="off" />
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
