import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { generateCodes, normalizePrefix as normalizePrefixServer, readConfig } from "../utils/bulkDiscountCodes.server";
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
  ProgressBar,
  IndexTable,
  Pagination,
  EmptyState,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import DateTimePicker from "../components/DateTimePicker";
import DiscountStatusToggle from "../components/DiscountStatusToggle";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const isNew = params.id === "new";

  const fnRes = await admin.graphql(
    `query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`
  );
  const fnData = await fnRes.json();
  const fn = fnData.data?.shopifyFunctions?.nodes?.find(
    (f) => f.apiType === "discount" && f.title === "Bulk Discount Generator"
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

  let d, config, resolvedGid;
  if (automaticGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        automaticDiscountNode(id: $id) {
          id
          metafield(namespace: "bulk_discount", key: "config") { value }
          automaticDiscount {
            ... on DiscountAutomaticApp {
              discountId title status startsAt endsAt
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
            }
          }
        }
      }`,
      { variables: { id: automaticGid } }
    );
    const node = (await res.json()).data?.automaticDiscountNode;
    if (node) { d = { ...node.automaticDiscount, codes: null }; config = node.metafield?.value ? JSON.parse(node.metafield.value) : {}; resolvedGid = automaticGid; }
  }
  if (!d && codeGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          metafield(namespace: "bulk_discount", key: "config") { value }
          codeDiscount {
            ... on DiscountCodeApp {
              discountId title status startsAt endsAt
              usageLimit appliesOncePerCustomer
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
              codesCount { count }
              codes(first: 1) { edges { node { code } } }
            }
          }
        }
      }`,
      { variables: { id: codeGid } }
    );
    const node = (await res.json()).data?.codeDiscountNode;
    if (node) { d = node.codeDiscount; config = node.metafield?.value ? JSON.parse(node.metafield.value) : {}; resolvedGid = codeGid; }
  }
  if (!d) return json({ functionId, discount: null, isNew: false, notFound: true });

  return json({
    functionId,
    isNew: false,
    discount: {
      nodeId: resolvedGid,
      discountId: d.discountId,
      discountType: "code",
      status: d.status,
      title: d.title,
      prefix: config.prefix ?? "",
      codesCount: d.codesCount?.count ?? config.codesGenerated ?? 0,
      targetCount: config.targetCount ?? d.codesCount?.count ?? config.codesGenerated ?? 0,
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      usageLimit: d.usageLimit?.toString() ?? "",
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? false,
      combinesWithProductDiscounts: d.combinesWith?.productDiscounts ?? false,
      combinesWithOrderDiscounts: d.combinesWith?.orderDiscounts ?? false,
      combinesWithShippingDiscounts: d.combinesWith?.shippingDiscounts ?? false,
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

// ── Code generation helpers ───────────────────────────────────────────────────

const MAX_GENERATE = 100000;
const CODES_PER_REQUEST = 250;
const CODES_PAGE_SIZE = 50;

function normalizePrefix(raw) {
  const clean = (raw || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/-+$/g, "");
  if (!clean) return "";
  return clean.endsWith("-") ? clean : `${clean}-`;
}

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const isNew = params.id === "new";

  const discountId = formData.get("discountId");
  const title = formData.get("title")?.trim();
  const discountValueType = formData.get("discountValueType");
  const discountValue = formData.get("discountValue");
  const minimumOrderAmount = formData.get("minimumOrderAmount");
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const combinesWithProductDiscounts = formData.get("combinesWithProductDiscounts") === "true";
  const combinesWithOrderDiscounts = formData.get("combinesWithOrderDiscounts") === "true";
  const combinesWithShippingDiscounts = formData.get("combinesWithShippingDiscounts") === "true";
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
  const prefixRaw = formData.get("prefix")?.trim() ?? "";
  const generateCount = parseInt(formData.get("generateCount") || "0", 10);
  const existingCodesCount = parseInt(formData.get("existingCodesCount") || "0", 10);

  if (!functionId) return json({ error: "Bulk Discount Generator function is not deployed yet." });

  const prefix = normalizePrefixServer(prefixRaw);
  if (!prefix) return json({ error: "A code prefix is required." });
  if (isNew && (!generateCount || generateCount < 1)) return json({ error: "Enter how many unique codes to generate." });
  if (generateCount > MAX_GENERATE) return json({ error: `You can generate at most ${MAX_GENERATE.toLocaleString()} codes at a time.` });
  if (discountValueType === "percentage" && parseFloat(discountValue) > 100) {
    return json({ error: "Percentage cannot exceed 100%." });
  }
  if (customerEligibility === "specific_tags" && customerTags.length === 0) {
    return json({ error: "Add at least one customer tag, or choose all customers." });
  }
  if (customerEligibility === "specific_customers" && selectedCustomers.length === 0) {
    return json({ error: "Select at least one customer, or choose all customers." });
  }

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;

  const existingTargetCount = parseInt(formData.get("existingTargetCount") || "0", 10);
  const existingConfig = (!isNew && discountId)
    ? await readConfig(admin, discountId.replace("DiscountAutomaticApp", "DiscountAutomaticNode").replace("DiscountCodeApp", "DiscountCodeNode"))
    : {};
  const addingMore = generateCount > 0;
  const targetCount = isNew
    ? generateCount
    : addingMore
      ? existingCodesCount + generateCount
      : (existingTargetCount || existingCodesCount);
  const codesGenerated = isNew ? 1 : existingCodesCount;
  const firstCode = isNew ? generateCodes(prefix, 1)[0] : null;

  const config = {
    prefix: prefixRaw.toUpperCase().replace(/[^A-Z0-9-]/g, ""),
    codesGenerated,
    codesSubmitted: addingMore
      ? existingCodesCount
      : Math.max(existingConfig.codesSubmitted ?? 0, codesGenerated),
    targetCount,
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

  const variables = {
    collectionIds: appliesTo === "collections" ? selectedCollections.map((c) => c.id) : [],
    eligibilityTags: customerEligibility === "specific_tags" ? customerTags : [],
  };

  const configMetafield = { namespace: "bulk_discount", key: "config", type: "json", value: JSON.stringify(config) };
  const variablesMetafield = { namespace: "bulk_discount", key: "variables", type: "json", value: JSON.stringify(variables) };

  const combinesWith = {
    productDiscounts: combinesWithProductDiscounts,
    orderDiscounts: combinesWithOrderDiscounts,
    shippingDiscounts: combinesWithShippingDiscounts,
  };

  const discountClasses = ["ORDER", "SHIPPING"];
  if (discountScope === "product") {
    discountClasses.push("PRODUCT");
  }

  const metafields = [configMetafield];
  const discountInput = {
    title,
    functionId,
    combinesWith,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    discountClasses,
    usageLimit: usageLimit ? parseInt(usageLimit, 10) : null,
    appliesOncePerCustomer,
    metafields,
  };

  try {
    let createdDiscountId;
    if (!isNew && discountId) {
      const response = await admin.graphql(
        `mutation($id: ID!, $d: DiscountCodeAppInput!) {
          discountCodeAppUpdate(id: $id, codeAppDiscount: $d) {
            codeAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
        { variables: { id: discountId, d: discountInput } }
      );
      const data = await response.json();
      const errors = data.data?.discountCodeAppUpdate?.userErrors ?? [];
      if (errors.length) return json({ error: errors[0].message });
      if (data.errors) return json({ error: data.errors[0].message });
      createdDiscountId = data.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId;
    } else {
      if (!firstCode) return json({ error: "Enter how many unique codes to generate." });
      const response = await admin.graphql(
        `mutation($d: DiscountCodeAppInput!) {
          discountCodeAppCreate(codeAppDiscount: $d) {
            codeAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
        { variables: { d: { ...discountInput, code: firstCode } } }
      );
      const data = await response.json();
      const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
      if (errors.length) return json({ error: errors.map((e) => `${e.field}: ${e.message}`).join("; ") });
      if (data.errors) return json({ error: data.errors[0].message });
      createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
    }

    const resolvedDiscountId = createdDiscountId || discountId;
    if (!resolvedDiscountId) return json({ error: "Discount saved but no ID returned." });

    const nodeId = resolvedDiscountId
      .replace("DiscountAutomaticApp", "DiscountAutomaticNode")
      .replace("DiscountCodeApp", "DiscountCodeNode");

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
            { ownerId: nodeId, ...configMetafield },
          ],
        },
      }
    );
    const mfErrors = (await mfRes.json()).data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) return json({ error: "Discount saved but config failed: " + mfErrors[0].message });

    return json({
      success: true,
      continueGeneration: targetCount > codesGenerated,
      nodeId,
      discountId: resolvedDiscountId,
      codesGenerated,
      targetCount,
      prefix: config.prefix,
    });
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
    prefix: "",
    generateCount: "100",
    title: "",
    discountValueType: ["percentage"],
    discountValue: "",
    minimumOrderAmount: "",
    startDateTime: nowLocal(),
    endDateTime: "",
    usageLimit: "",
    appliesOncePerCustomer: true,
    combinesWithProductDiscounts: true,
    combinesWithOrderDiscounts: true,
    combinesWithShippingDiscounts: true,
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
    prefix: d.prefix || "",
    generateCount: "",
    title: d.title,
    discountValueType: [d.discountValueType || "percentage"],
    discountValue: d.discountValue || "",
    minimumOrderAmount: d.minimumOrderAmount || "",
    startDateTime: d.startsAt,
    endDateTime: d.endsAt,
    usageLimit: d.usageLimit,
    appliesOncePerCustomer: d.appliesOncePerCustomer,
    combinesWithProductDiscounts: d.combinesWithProductDiscounts ?? false,
    combinesWithOrderDiscounts: d.combinesWithOrderDiscounts ?? false,
    combinesWithShippingDiscounts: d.combinesWithShippingDiscounts ?? false,
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

// ── Unique codes list (Shopify-style browse) ─────────────────────────────────

function UniqueCodesCard({ nodeId, postForm, shopify, refreshKey, onTotalChange, overrideTotal }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [endCursor, setEndCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pageIndex, setPageIndex] = useState(0);
  const cursors = useRef([null]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    cursors.current = [null];
    setPageIndex(0);
  }, [debouncedSearch, refreshKey, nodeId]);

  const loadPage = useCallback(async () => {
    if (!nodeId) return;
    setLoading(true);
    setError(null);
    try {
      const data = new FormData();
      data.append("action", "exportCodes");
      data.append("nodeId", nodeId);
      data.append("first", String(CODES_PAGE_SIZE));
      const cursor = cursors.current[pageIndex];
      if (cursor) data.append("cursor", cursor);
      if (debouncedSearch) data.append("query", debouncedSearch);
      const page = await postForm(data);
      if (page.error) throw new Error(page.error);
      setItems(page.items ?? (page.codes ?? []).map((code) => ({ code, usage: 0 })));
      const nextTotal = page.total ?? 0;
      setTotal(nextTotal);
      onTotalChange?.(nextTotal);
      setHasNextPage(!!page.hasNextPage);
      setEndCursor(page.endCursor ?? null);
    } catch (err) {
      setError(err.message || "Could not load codes.");
    } finally {
      setLoading(false);
    }
  }, [nodeId, postForm, pageIndex, debouncedSearch, refreshKey, onTotalChange]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  const goNext = () => {
    if (!endCursor) return;
    cursors.current[pageIndex + 1] = endCursor;
    setPageIndex((i) => i + 1);
  };

  const goPrevious = () => {
    setPageIndex((i) => Math.max(0, i - 1));
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      shopify.toast.show(`Copied ${code}`);
    } catch {
      shopify.toast.show("Could not copy code.", { isError: true });
    }
  };

  const shownTotal = overrideTotal ?? total;
  const rangeStart = items.length ? pageIndex * CODES_PAGE_SIZE + 1 : 0;
  const rangeEnd = pageIndex * CODES_PAGE_SIZE + items.length;
  const showingLabel = items.length
    ? `Showing ${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()}`
    : "";

  return (
    <Card padding="0">
      <Box padding="400">
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Unique codes</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {shownTotal.toLocaleString()} code{shownTotal === 1 ? "" : "s"} on this price rule
              </Text>
            </BlockStack>
          </InlineStack>
          <TextField
            label="Search codes"
            labelHidden
            value={search}
            onChange={setSearch}
            placeholder="Search codes"
            autoComplete="off"
            clearButton
            onClearButtonClick={() => setSearch("")}
          />
        </BlockStack>
      </Box>

      {error && (
        <Box paddingInline="400" paddingBlockEnd="400">
          <Banner tone="critical"><Text>{error}</Text></Banner>
        </Box>
      )}

      {loading && items.length === 0 ? (
        <Box padding="800">
          <InlineStack align="center"><Spinner size="small" /></InlineStack>
        </Box>
      ) : items.length === 0 ? (
        <EmptyState
          heading={debouncedSearch ? "No matching codes" : "No codes yet"}
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>
            {debouncedSearch
              ? `Nothing matches “${debouncedSearch}”.`
              : "Codes will appear here after they are generated."}
          </p>
        </EmptyState>
      ) : (
        <IndexTable
          resourceName={{ singular: "code", plural: "codes" }}
          itemCount={items.length}
          selectable={false}
          headings={[
            { title: "Code" },
            { title: "Used" },
            { title: "" },
          ]}
        >
          {items.map((item, i) => (
            <IndexTable.Row id={item.code} key={item.code} position={i}>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd" fontWeight="semibold">{item.code}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span">{item.usage ?? 0}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Button variant="plain" onClick={() => copyCode(item.code)}>Copy</Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      )}

      {(hasNextPage || pageIndex > 0) && (
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              {showingLabel}
              {loading ? " · Loading…" : ""}
            </Text>
            <Pagination
              hasPrevious={pageIndex > 0}
              onPrevious={goPrevious}
              hasNext={hasNextPage}
              onNext={goNext}
            />
          </InlineStack>
        </Box>
      )}
    </Card>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BulkDiscountGeneratorForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;

  const [form, setForm] = useState(() => isEditing ? buildFromDiscount(discount) : buildEmpty());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [job, setJob] = useState(null);
  const [exportProgress, setExportProgress] = useState(null);
  const [codesRefresh, setCodesRefresh] = useState(0);
  const [liveCodesCount, setLiveCodesCount] = useState(discount?.codesCount ?? 0);
  const startedJob = useRef(null);
  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);
  const customerSearch = useCustomerSearch();

  const postForm = useCallback(async (data) => {
    let lastError = "Request failed.";
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = { Accept: "application/json" };
      try {
        const token = await shopify.idToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch {
        // Fall through and try the cookie session.
      }
      const res = await fetch("/api/bulk-discount-codes", {
        method: "POST",
        body: data,
        headers,
        credentials: "same-origin",
      });
      const text = await res.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("<")) {
        lastError = res.status === 401
          ? "Session expired. Refresh the page and click Resume generation."
          : `Shopify returned an HTML page (${res.status}). Retrying…`;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastError = "The server returned an unexpected response. Retrying…";
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
        continue;
      }
      if (!res.ok && parsed.error) throw new Error(parsed.error);
      return parsed;
    }
    throw new Error(lastError);
  }, [shopify]);

  const runGeneration = useCallback(async ({ nodeId, prefix, generated, target }) => {
    let current = generated;
    let queued = generated;
    let stalled = 0;
    setJob({ nodeId, prefix, generated: current, target, batch: CODES_PER_REQUEST });
    setLiveCodesCount(current);
    try {
      while (queued < target && current < target) {
        const startData = new FormData();
        startData.append("action", "generateBatch");
        startData.append("nodeId", nodeId);
        startData.append("prefix", prefix);
        const start = await postForm(startData);
        if (start.error) throw new Error(start.error);
        current = Math.max(current, start.codesCount ?? 0);
        queued = Math.max(queued, start.codesSubmitted ?? queued);
        const submitted = start.submitted || 0;
        setJob({ nodeId, prefix, generated: current, target, queued, batch: submitted || CODES_PER_REQUEST });
        setLiveCodesCount(current);
        if (start.done || queued >= target || current >= target) break;
        if (start.lostRace) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        if (!start.jobId) throw new Error("Shopify did not start a bulk code job.");

        const before = current;
        let done = false;
        for (let attempt = 0; attempt < 120 && !done; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 750));
          const statusData = new FormData();
          statusData.append("action", "jobStatus");
          statusData.append("nodeId", nodeId);
          statusData.append("jobId", start.jobId);
          const status = await postForm(statusData);
          if (status.error) throw new Error(status.error);
          current = Math.max(current, status.codesCount ?? 0);
          queued = Math.max(queued, status.codesSubmitted ?? queued);
          done = !!status.done;
          if (current >= target) break;
          setJob({
            nodeId,
            prefix,
            generated: current,
            target,
            queued,
            batch: submitted || CODES_PER_REQUEST,
            imported: status.imported || 0,
          });
          setLiveCodesCount(current);
        }
        if (!done) throw new Error("Timed out waiting for Shopify to finish adding codes.");

        if (current <= before && submitted > 0) {
          stalled += 1;
          if (stalled >= 5) {
            throw new Error(`Shopify is not adding more codes. ${current.toLocaleString()} of ${target.toLocaleString()} are ready. Try Resume generation in a moment.`);
          }
        } else {
          stalled = 0;
        }
      }
      shopify.toast.show(`${current.toLocaleString()} unique codes are on this price rule.`);
      set("generateCount", "");
      if (!isEditing && nodeId) {
        navigate(`/app/bulk-discount-generator/${encodeURIComponent(nodeId)}`);
      }
    } catch (err) {
      shopify.toast.show(err.message || "Code generation stopped.", { isError: true });
    } finally {
      setIsSubmitting(false);
      setJob((prev) => prev ? { ...prev, generated: current, target, done: current >= target } : prev);
      setLiveCodesCount(current);
      setCodesRefresh((n) => n + 1);
    }
  }, [isEditing, navigate, postForm, set, shopify]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      if (fetcher.data.continueGeneration && fetcher.data.codesGenerated < fetcher.data.targetCount) {
        const key = `${fetcher.data.nodeId}:${fetcher.data.targetCount}`;
        if (startedJob.current === key) return;
        startedJob.current = key;
        shopify.toast.show(isEditing ? "Price rule saved. Generating codes…" : "Price rule created. Generating codes…");
        runGeneration({
          nodeId: fetcher.data.nodeId,
          prefix: fetcher.data.prefix,
          generated: fetcher.data.codesGenerated,
          target: fetcher.data.targetCount,
        });
        return;
      }
      shopify.toast.show(isEditing ? "Price rule updated." : "Price rule created.");
      if (!isEditing) setForm(buildEmpty());
      else set("generateCount", "");
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing, set, runGeneration]);

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

  const handleExport = useCallback(async () => {
    if (!discount?.nodeId) return;
    setExportProgress({ current: 0, total: discount.codesCount || 0 });
    try {
      const all = [];
      let cursor = null;
      let hasNext = true;
      while (hasNext) {
        const data = new FormData();
        data.append("action", "exportCodes");
        data.append("nodeId", discount.nodeId);
        if (cursor) data.append("cursor", cursor);
        const page = await postForm(data);
        if (page.error) throw new Error(page.error);
        all.push(...(page.codes ?? []));
        hasNext = !!page.hasNextPage;
        cursor = page.endCursor;
        setExportProgress({ current: all.length, total: page.total || all.length });
      }
      const csv = ["code", ...all].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(form.prefix || "codes").toLowerCase()}-discount-codes.csv`;
      a.click();
      URL.revokeObjectURL(url);
      shopify.toast.show(`Downloaded ${all.length.toLocaleString()} codes.`);
    } catch (err) {
      shopify.toast.show(err.message || "Export failed.", { isError: true });
    } finally {
      setExportProgress(null);
    }
  }, [discount, form.prefix, postForm, shopify]);

  const handleSubmit = useCallback(() => {
    if (!form.prefix.trim()) { shopify.toast.show("A code prefix is required.", { isError: true }); return; }
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (!isEditing && (!form.generateCount || parseInt(form.generateCount, 10) < 1)) { shopify.toast.show("Enter how many unique codes to generate.", { isError: true }); return; }
    if (form.generateCount && parseInt(form.generateCount, 10) > MAX_GENERATE) { shopify.toast.show(`You can generate at most ${MAX_GENERATE.toLocaleString()} codes at a time.`, { isError: true }); return; }
    if (!form.discountValue || parseFloat(form.discountValue) <= 0) { shopify.toast.show("Enter a discount value greater than 0.", { isError: true }); return; }
    if (form.discountValueType[0] === "percentage" && parseFloat(form.discountValue) > 100) { shopify.toast.show("Percentage cannot exceed 100%.", { isError: true }); return; }
    if (form.customerEligibility[0] === "specific_tags" && form.customerTags.length === 0) { shopify.toast.show("Add at least one customer tag, or choose all customers.", { isError: true }); return; }
    if (form.customerEligibility[0] === "specific_customers" && form.selectedCustomers.length === 0) { shopify.toast.show("Select at least one customer, or choose all customers.", { isError: true }); return; }
    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("prefix", form.prefix);
    data.append("generateCount", form.generateCount || "0");
    data.append("existingCodesCount", String(liveCodesCount ?? discount?.codesCount ?? 0));
    data.append("existingTargetCount", String(discount?.targetCount ?? 0));
    data.append("title", form.title);
    data.append("discountValueType", form.discountValueType[0]);
    data.append("discountValue", form.discountValue);
    data.append("minimumOrderAmount", form.minimumOrderAmount);
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("combinesWithProductDiscounts", String(form.combinesWithProductDiscounts));
    data.append("combinesWithOrderDiscounts", String(form.combinesWithOrderDiscounts));
    data.append("combinesWithShippingDiscounts", String(form.combinesWithShippingDiscounts));
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
  }, [form, fetcher, functionId, shopify, isEditing, discount, liveCodesCount]);

  const handleCodesTotal = useCallback((n) => {
    setLiveCodesCount((prev) => Math.max(prev, n));
  }, []);

  const displayCodesCount = Math.max(liveCodesCount, job?.generated ?? 0);
  const generationRunning = !!job && !job.done;

  if (notFound) return (
    <Page backAction={{ content: "All discounts", url: "/app/bulk-discount-generator" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  const valueLabel = form.discountValueType[0] === "percentage" ? "Percentage off (%)" : "Fixed amount off ($)";
  const pageTitle = isEditing ? "Edit price rule" : "Create price rule";
  const isProductScope = form.discountScope[0] === "product";

  return (
    <Page backAction={{ content: "All discounts", url: "/app/bulk-discount-generator" }} title={pageTitle}>
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Bulk Discount Generator function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
          </Banner>
        </Box>
      )}

      {job && !job.done && (
        <Box paddingBlockEnd="400">
          <Banner tone="info">
            <BlockStack gap="200">
              <Text variant="bodyMd" fontWeight="semibold">
                Generating unique codes… {job.generated.toLocaleString()} of {job.target.toLocaleString()}
              </Text>
              <ProgressBar progress={job.target ? Math.min(100, Math.round((job.generated / job.target) * 100)) : 0} />
              <Text variant="bodySm" tone="subdued">
                Shopify is processing a batch of {job.batch || 250}
                {typeof job.imported === "number" ? ` (${job.imported} imported so far)` : ""}.
                {" "}Keep this page open until generation finishes.
              </Text>
            </BlockStack>
          </Banner>
        </Box>
      )}

      {exportProgress && (
        <Box paddingBlockEnd="400">
          <Banner>
            <BlockStack gap="200">
              <Text variant="bodyMd">Preparing CSV… {exportProgress.current.toLocaleString()} of {exportProgress.total.toLocaleString()}</Text>
              <ProgressBar progress={exportProgress.total ? Math.min(100, Math.round((exportProgress.current / exportProgress.total) * 100)) : 0} />
            </BlockStack>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {isEditing && discount?.status && (
              <Card>
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" fontWeight="medium">Discount status</Text>
                    <Badge tone={discount.status === "ACTIVE" ? "success" : discount.status === "SCHEDULED" ? "info" : "critical"}>
                      {discount.status.charAt(0) + discount.status.slice(1).toLowerCase()}
                    </Badge>
                  </InlineStack>
                  <DiscountStatusToggle discountId={discount.nodeId} discountType="code" status={discount.status} size="medium" />
                </InlineStack>
              </Card>
            )}

            {/* ── Discount details ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Price rule</Text>
                <TextField label="Title" value={form.title} onChange={(v) => set("title", v)} placeholder="e.g., Summer unique codes" helpText="Internal name for this set of unique codes" autoComplete="off" />
                <TextField
                  label="Code prefix"
                  value={form.prefix}
                  onChange={(v) => set("prefix", v.toUpperCase())}
                  placeholder="e.g., SUMMER"
                  helpText="Each unique code is this prefix plus a random suffix, like SUMMER-A7K2M9PQZX."
                  autoComplete="off"
                  disabled={isEditing}
                />
                {isEditing ? (
                  <BlockStack gap="300">
                    <Banner tone="info">
                      <Text variant="bodyMd">
                        {displayCodesCount.toLocaleString()} unique codes generated under this price rule
                        {form.prefix ? ` with prefix ${normalizePrefix(form.prefix).replace(/-$/, "")}` : ""}.
                        {discount.targetCount && discount.targetCount !== displayCodesCount
                          ? ` ${discount.targetCount.toLocaleString()} were requested.`
                          : ""}
                      </Text>
                    </Banner>
                    {discount.targetCount > displayCodesCount && (
                      <Button
                        onClick={() => runGeneration({
                          nodeId: discount.nodeId,
                          prefix: form.prefix,
                          generated: displayCodesCount,
                          target: discount.targetCount,
                        })}
                        loading={generationRunning}
                      >
                        Resume generation
                      </Button>
                    )}
                    <InlineStack gap="300" wrap>
                      <Box maxWidth="220px">
                        <TextField
                          label="Generate additional codes"
                          type="number"
                          value={form.generateCount}
                          onChange={(v) => set("generateCount", v)}
                          min={1}
                          max={MAX_GENERATE}
                          helpText="Leave empty to only update the terms. Up to 100,000."
                          autoComplete="off"
                        />
                      </Box>
                      <Box paddingBlockStart="600">
                        <Button onClick={handleExport} loading={!!exportProgress}>Download codes CSV</Button>
                      </Box>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Box maxWidth="220px">
                    <TextField
                      label="How many codes to generate"
                      type="number"
                      value={form.generateCount}
                      onChange={(v) => set("generateCount", v)}
                      min={1}
                      max={MAX_GENERATE}
                      helpText="Up to 100,000 unique codes. Large batches keep running in the background on this page."
                      autoComplete="off"
                    />
                  </Box>
                )}
              </BlockStack>
            </Card>

            {isEditing && discount?.nodeId && (
              <UniqueCodesCard
                nodeId={discount.nodeId}
                postForm={postForm}
                shopify={shopify}
                refreshKey={codesRefresh}
                onTotalChange={handleCodesTotal}
                overrideTotal={displayCodesCount}
              />
            )}

            {/* ── Discount value ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount value</Text>
                <ChoiceList title="Value type" choices={[{ label: "Percentage off", value: "percentage" }, { label: "Fixed amount off", value: "amount" }]} selected={form.discountValueType} onChange={(v) => set("discountValueType", v)} />
                <Box maxWidth="200px">
                  <TextField label={valueLabel} type="number" value={form.discountValue} onChange={(v) => set("discountValue", v)} prefix={form.discountValueType[0] === "amount" ? "$" : undefined} suffix={form.discountValueType[0] === "percentage" ? "%" : undefined} min={0} max={form.discountValueType[0] === "percentage" ? 100 : undefined} helpText={form.discountValueType[0] === "amount" && form.discountScope[0] === "product" ? "Taken off each qualifying item, and never more than that item's price." : undefined} autoComplete="off" />
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
                      helpText={
                        form.discountValueType[0] === "amount"
                          ? "Fixed amounts are taken off each item, never more than that item's price. Set a max here to cap how many units get the discount."
                          : "Leave empty to discount all qualifying items."
                      }
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
                  <Text as="p" variant="bodyMd" tone="subdued">Bundle free shipping so customers only need one code. Every eligible rate at checkout is set to $0, not just the cheapest.</Text>
                </BlockStack>
                <Checkbox label="Include free shipping with this discount" checked={form.includesFreeShipping} onChange={(v) => set("includesFreeShipping", v)} />
                {form.includesFreeShipping && (
                  <BlockStack gap="300">
                    <TextField label="Minimum order for free shipping (optional)" type="number" value={form.freeShippingMinimum} onChange={(v) => set("freeShippingMinimum", v)} prefix="$" min={0} helpText={form.minimumOrderAmount ? `Leave empty to use discount minimum ($${form.minimumOrderAmount})` : "Leave empty for no minimum"} autoComplete="off" />
                    <TextField label="Maximum shipping rate to make free (optional)" type="number" value={form.maxShippingCost} onChange={(v) => set("maxShippingCost", v)} prefix="$" min={0} helpText="All rates at or below this amount become free. Leave empty to make every shipping rate $0." autoComplete="off" />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* ── Combinations ── */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Combinations</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">Choose which other discounts this one can stack with at checkout.</Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Checkbox label="Product discounts" checked={form.combinesWithProductDiscounts} onChange={(v) => set("combinesWithProductDiscounts", v)} />
                  <Checkbox label="Order discounts" checked={form.combinesWithOrderDiscounts} onChange={(v) => set("combinesWithOrderDiscounts", v)} />
                  <Checkbox label="Shipping discounts" checked={form.combinesWithShippingDiscounts} onChange={(v) => set("combinesWithShippingDiscounts", v)} />
                </BlockStack>
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
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Usage limits</Text>
                <TextField
                  label="Maximum redemptions across all codes (optional)"
                  type="number"
                  value={form.usageLimit}
                  onChange={(v) => set("usageLimit", v)}
                  min={0}
                  helpText="Applies to the whole price rule, not each individual code. Leave empty for unlimited."
                  autoComplete="off"
                />
                <Checkbox label="Limit to one use per customer" checked={form.appliesOncePerCustomer} onChange={(v) => set("appliesOncePerCustomer", v)} />
              </BlockStack>
            </Card>

            <InlineStack align="end">
              <Button variant="primary" onClick={handleSubmit} loading={isSubmitting || (!!job && !job.done)} disabled={isSubmitting || !functionId || (!!job && !job.done)}>
                {isEditing ? "Save changes" : "Generate codes"}
              </Button>
            </InlineStack>

            <Box paddingBlockEnd="1000" />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
