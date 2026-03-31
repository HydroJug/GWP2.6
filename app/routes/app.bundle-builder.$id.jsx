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
  Thumbnail,
  Divider,
  ChoiceList,
  Checkbox,
  ButtonGroup,
  Badge,
  Spinner,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
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
    (f) => f.title === "Bundle Builder" && f.apiType === "discount"
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
          metafield(namespace: "bundle_builder", key: "config") { value }
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
          metafield(namespace: "bundle_builder", key: "config") { value }
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
      // For bundle reconstruction — each bundle item stores type/id/label
      bundles: config.bundles ?? [],
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const isNew = params.id === "new";

  if (formData.get("action") === "searchCollections") {
    const cursor = formData.get("cursor") || null;
    const res = await admin.graphql(
      `query($q: String!, $cursor: String) { collections(first: 25, query: $q, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title image { url } productsCount { count } } } }`,
      { variables: { q: formData.get("query") ?? "", cursor } }
    );
    const data = await res.json();
    const c = data.data.collections;
    return json({ collections: c.nodes, pageInfo: c.pageInfo, append: !!cursor, searchKey: formData.get("searchKey") });
  }

  if (formData.get("action") === "searchProducts") {
    const cursor = formData.get("cursor") || null;
    const res = await admin.graphql(
      `query($q: String!, $cursor: String) { products(first: 25, query: $q, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title featuredImage { url } } } }`,
      { variables: { q: formData.get("query") ?? "", cursor } }
    );
    const data = await res.json();
    const p = data.data.products;
    return json({ products: p.nodes, pageInfo: p.pageInfo, append: !!cursor, searchKey: formData.get("searchKey") });
  }

  const discountId = formData.get("discountId");
  const discountType = formData.get("discountType") ?? "automatic";
  const code = formData.get("code")?.trim();
  const title = formData.get("title")?.trim();
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const functionId = formData.get("functionId");
  const bundlesJson = formData.get("bundles");

  if (!functionId) return json({ error: "Bundle Builder function is not deployed yet." });

  let bundlesDraft;
  try { bundlesDraft = JSON.parse(bundlesJson); } catch { return json({ error: "Invalid bundle data." }); }

  // Assign slot indices to collection items only (max 7 for inAnyCollection)
  const slotMap = new Map();
  let nextSlot = 0;
  const variablesData = {};
  for (const bundle of bundlesDraft) {
    for (const item of bundle.items) {
      if (item.type === "product") continue;
      if (!slotMap.has(item.id)) {
        if (nextSlot > 6) return json({ error: "Too many unique collection groups across all tiers (max 7)." });
        variablesData[`s${nextSlot}`] = [item.id];
        slotMap.set(item.id, nextSlot++);
      }
    }
  }

  const resolvedBundles = bundlesDraft.map((bundle) => ({
    label: bundle.label,
    discountType: bundle.discountType,
    discountValue: bundle.discountValue,
    maxBundles: bundle.maxBundles ?? null,
    items: bundle.items.map((item) => {
      if (item.type === "product") {
        return { type: "product", productId: item.id, label: item.label, minQty: item.minQty ?? 1, id: item.id, image: item.image ?? null };
      }
      return { type: "collection", slot: slotMap.get(item.id), label: item.label, minQty: item.minQty ?? 1, id: item.id, image: item.image ?? null };
    }),
  }));

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;
  const configJson = JSON.stringify({ bundles: resolvedBundles });
  const combinesWith = { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true };
  const discountClasses = ["PRODUCT"];

  const discountInput = {
    title, functionId, combinesWith, startsAt,
    ...(endsAt ? { endsAt } : {}),
    discountClasses,
  };

  console.log("[BundleBuilder Action] configJson length:", configJson.length, "bytes");

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
          { variables: { id: discountId, d: discountInput } }
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
          { variables: { id: discountId, d: { ...discountInput, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer } } }
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
          { variables: { d: discountInput } }
        );
        const data = await response.json();
        const errors = data.data?.discountAutomaticAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
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
          { variables: { d: { ...discountInput, code, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer } } }
        );
        const data = await response.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
      }
    }

    if (!createdDiscountId) return json({ error: "Discount saved but no ID returned." });

    const nodeId = createdDiscountId
      .replace("DiscountAutomaticApp", "DiscountAutomaticNode")
      .replace("DiscountCodeApp", "DiscountCodeNode");

    const variablesJson = JSON.stringify(variablesData);
    const metafieldsSetRes = await admin.graphql(
      `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { namespace key }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          metafields: [
            { ownerId: nodeId, namespace: "bundle_builder", key: "config", type: "json", value: configJson },
            { ownerId: nodeId, namespace: "bundle_builder", key: "variables", type: "json", value: variablesJson },
          ],
        },
      }
    );
    const mfData = await metafieldsSetRes.json();
    const mfErrors = mfData.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) {
      console.log("[BundleBuilder] metafieldsSet errors:", JSON.stringify(mfErrors));
      return json({ error: "Discount saved but config failed: " + mfErrors[0].message });
    }
    console.log("[BundleBuilder Action] metafields saved on", nodeId, "config:", configJson.length, "bytes, variables:", variablesJson.length, "bytes");

    return json({ success: true });
  } catch (err) {
    console.log("[BundleBuilder Action] ERROR:", err.message);
    return json({ error: err.message });
  }
};

// ── Item Picker ───────────────────────────────────────────────────────────────

function ItemPicker({ pickerType, onPickerTypeChange, selected, onSelect, searchQuery, onSearchChange, results, isSearching, hasNextPage, isLoadingMore, onLoadMore }) {
  const [focused, setFocused] = useState(false);
  const showDropdown = focused && results.length > 0;

  const handleDropdownScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (!hasNextPage || isLoadingMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) onLoadMore?.();
  }, [hasNextPage, isLoadingMore, onLoadMore]);

  return (
    <BlockStack gap="200">
      <ButtonGroup variant="segmented">
        <Button size="slim" pressed={pickerType === "collection"} onClick={() => { onPickerTypeChange("collection"); onSelect(null); onSearchChange(""); }}>Collection</Button>
        <Button size="slim" pressed={pickerType === "product"} onClick={() => { onPickerTypeChange("product"); onSelect(null); onSearchChange(""); }}>Specific product</Button>
      </ButtonGroup>

      {selected ? (
        <InlineStack gap="200" align="start" blockAlign="center">
          {selected.image
            ? <Thumbnail source={selected.image} alt={selected.title} size="extraSmall" />
            : <Box width="32px" minHeight="32px" background="bg-surface-secondary" borderRadius="100" />
          }
          <Box><Text variant="bodySm" fontWeight="semibold">{selected.title}</Text></Box>
          <Button variant="plain" tone="critical" size="slim" onClick={() => { onSelect(null); onSearchChange(""); }}>Remove</Button>
        </InlineStack>
      ) : (
        <div style={{ position: "relative" }}>
          <TextField label="" labelHidden placeholder={pickerType === "collection" ? "Search collections…" : "Search products…"} value={searchQuery} onChange={onSearchChange} loading={isSearching} autoComplete="off" clearButton onClearButtonClick={() => onSearchChange("")} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 200)} />
          {showDropdown && (
            <div onScroll={handleDropdownScroll} style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 99999, background: "var(--p-color-bg-surface)", border: "1px solid var(--p-color-border)", borderRadius: "var(--p-border-radius-200)", boxShadow: "var(--p-shadow-300)", maxHeight: 280, overflowY: "auto" }}>
              {results.map((item) => (
                <button key={item.id} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onSelect({ id: item.id, title: item.title, image: item.image?.url ?? item.featuredImage?.url ?? null }); onSearchChange(""); setFocused(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                  {(item.image?.url ?? item.featuredImage?.url)
                    ? <img src={item.image?.url ?? item.featuredImage?.url} alt="" style={{ width: 28, height: 28, borderRadius: 3, objectFit: "cover", flexShrink: 0 }} />
                    : <div style={{ width: 28, height: 28, borderRadius: 3, background: "var(--p-color-bg-surface-secondary)", flexShrink: 0 }} />
                  }
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{item.title}</div>
                    {item.productsCount?.count !== undefined && <div style={{ fontSize: 11, color: "var(--p-color-text-subdued)" }}>{item.productsCount.count} products</div>}
                  </div>
                </button>
              ))}
              {isLoadingMore && <div style={{ display: "flex", justifyContent: "center", padding: 8 }}><Spinner size="small" /></div>}
            </div>
          )}
        </div>
      )}
    </BlockStack>
  );
}

// ── State helpers ─────────────────────────────────────────────────────────────

function makeBundleItem(fromConfig) {
  if (fromConfig) {
    return {
      id: crypto.randomUUID(),
      pickerType: fromConfig.type ?? "collection",
      selected: fromConfig.id ? { id: fromConfig.id, title: fromConfig.label ?? fromConfig.id, image: fromConfig.image ?? null } : null,
      searchQuery: "",
      results: [],
      isSearching: false,
      isLoadingMore: false,
      hasNextPage: false,
      endCursor: null,
      minQty: String(fromConfig.minQty ?? 1),
    };
  }
  return { id: crypto.randomUUID(), pickerType: "collection", selected: null, searchQuery: "", results: [], isSearching: false, isLoadingMore: false, hasNextPage: false, endCursor: null, minQty: "1" };
}

function makeBundle(fromConfig) {
  if (fromConfig) {
    return {
      id: crypto.randomUUID(),
      label: fromConfig.label ?? "",
      discountType: [fromConfig.discountType ?? "percentage"],
      discountValue: String(fromConfig.discountValue ?? ""),
      maxBundles: String(fromConfig.maxBundles ?? ""),
      items: (fromConfig.items ?? []).map(makeBundleItem),
    };
  }
  return { id: crypto.randomUUID(), label: "", discountType: ["percentage"], discountValue: "", maxBundles: "", items: [makeBundleItem()] };
}

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const emptyForm = { discountType: ["automatic"], code: "", title: "", startDateTime: nowLocal(), endDateTime: "", usageLimit: "", appliesOncePerCustomer: false };

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BundleBuilderForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;
  const pageTitle = isEditing ? "Edit bundle discount" : "Create bundle discount";

  const [form, setForm] = useState(() => isEditing
    ? { discountType: [discount.discountType], code: discount.code, title: discount.title, startDateTime: discount.startsAt, endDateTime: discount.endsAt, usageLimit: discount.usageLimit, appliesOncePerCustomer: discount.appliesOncePerCustomer }
    : emptyForm
  );
  const [bundles, setBundles] = useState(() =>
    isEditing && discount.bundles?.length
      ? discount.bundles.map(makeBundle)
      : [makeBundle()]
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingSearch = useRef(null);

  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);
  const updateBundle = useCallback((bid, field, value) => setBundles((prev) => prev.map((b) => b.id === bid ? { ...b, [field]: value } : b)), []);
  const updateItem = useCallback((bid, iid, field, value) => setBundles((prev) => prev.map((b) => b.id !== bid ? b : { ...b, items: b.items.map((item) => item.id === iid ? { ...item, [field]: value } : item) })), []);
  const addItem = useCallback((bid) => setBundles((prev) => prev.map((b) => b.id === bid ? { ...b, items: [...b.items, makeBundleItem()] } : b)), []);
  const removeItem = useCallback((bid, iid) => setBundles((prev) => prev.map((b) => b.id !== bid ? b : { ...b, items: b.items.filter((i) => i.id !== iid) })), []);
  const addBundle = useCallback(() => setBundles((prev) => [...prev, makeBundle()]), []);
  const removeBundle = useCallback((bid) => setBundles((prev) => prev.filter((b) => b.id !== bid)), []);

  const triggerSearch = useCallback((bid, iid, pickerType, query) => {
    const searchKey = `${bid}__${iid}`;
    pendingSearch.current = { searchKey, bid, iid };
    updateItem(bid, iid, "isSearching", true);
    const data = new FormData();
    data.append("action", pickerType === "product" ? "searchProducts" : "searchCollections");
    data.append("query", query);
    data.append("searchKey", searchKey);
    fetcher.submit(data, { method: "POST" });
  }, [fetcher, updateItem]);

  const loadMoreSearch = useCallback((bid, iid, pickerType, query, cursor) => {
    const searchKey = `${bid}__${iid}`;
    setBundles((prev) => prev.map((b) => b.id !== bid ? b : { ...b, items: b.items.map((item) => item.id === iid ? { ...item, isLoadingMore: true } : item) }));
    const data = new FormData();
    data.append("action", pickerType === "product" ? "searchProducts" : "searchCollections");
    data.append("query", query);
    data.append("searchKey", searchKey);
    data.append("cursor", cursor);
    fetcher.submit(data, { method: "POST" });
  }, [fetcher]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.collections !== undefined || fetcher.data.products !== undefined) {
      const searchKey = fetcher.data.searchKey;
      if (!searchKey) return;
      const [bid, iid] = searchKey.split("__");
      const newResults = fetcher.data.collections ?? fetcher.data.products ?? [];
      const isAppend = !!fetcher.data.append;
      const pageInfo = fetcher.data.pageInfo;
      setBundles((prev) => prev.map((b) => b.id !== bid ? b : { ...b, items: b.items.map((item) => {
        if (item.id !== iid) return item;
        return {
          ...item,
          results: isAppend ? [...item.results, ...newResults] : newResults,
          isSearching: false,
          isLoadingMore: false,
          hasNextPage: pageInfo?.hasNextPage ?? false,
          endCursor: pageInfo?.endCursor ?? null,
        };
      }) }));
    } else if (fetcher.data.success) {
      shopify.toast.show(isEditing ? "Bundle discount updated!" : "Bundle discount created!");
      if (!isEditing) { setForm(emptyForm); setBundles([makeBundle()]); }
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing]);

  const handleSubmit = useCallback(() => {
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (form.discountType[0] === "code" && !form.code.trim()) { shopify.toast.show("Discount code is required.", { isError: true }); return; }
    for (const bundle of bundles) {
      if (!bundle.discountValue || parseFloat(bundle.discountValue) <= 0) { shopify.toast.show("Each bundle needs a discount value greater than 0.", { isError: true }); return; }
      for (const item of bundle.items) {
        if (!item.selected) { shopify.toast.show("Select a product or collection for every bundle item.", { isError: true }); return; }
      }
    }
    setIsSubmitting(true);
    const bundlesPayload = bundles.map((b) => ({
      label: b.label || b.items.map((i) => i.selected?.title).join(" + "),
      discountType: b.discountType[0],
      discountValue: parseFloat(b.discountValue),
      maxBundles: b.maxBundles ? parseInt(b.maxBundles, 10) : null,
      items: b.items.map((item) => ({ type: item.pickerType, id: item.selected.id, label: item.selected.title, image: item.selected.image ?? null, minQty: parseInt(item.minQty || "1", 10) })),
    }));
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("discountType", form.discountType[0]);
    data.append("code", form.code);
    data.append("title", form.title);
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("functionId", functionId ?? "");
    data.append("bundles", JSON.stringify(bundlesPayload));
    fetcher.submit(data, { method: "POST" });
  }, [form, bundles, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) return (
    <Page backAction={{ content: "All discounts", url: "/app/bundle-builder" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  return (
    <Page backAction={{ content: "All discounts", url: "/app/bundle-builder" }} title={pageTitle}>
      <TitleBar title={pageTitle} />
      <style>{`
        .bb-bundles, .bb-bundles .Polaris-Box, .bb-bundles .Polaris-Card, .bb-bundles .Polaris-ShadowBevel, .bb-bundles .Polaris-BlockStack { overflow: visible !important; }
        .bb-bundles .Polaris-ShadowBevel { isolation: auto !important; contain: none !important; }
        .bb-bundles ~ * { position: relative; z-index: 1; }
        .bb-add-bundle { position: relative; z-index: 0; }
      `}</style>

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Bundle Builder function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount details</Text>
                <ChoiceList title="Discount type" choices={[{ label: "Automatic discount", value: "automatic" }, { label: "Discount code", value: "code" }]} selected={form.discountType} onChange={(v) => set("discountType", v)} />
                {form.discountType[0] === "code" && (
                  <TextField label="Discount code" value={form.code} onChange={(v) => set("code", v)} placeholder="e.g., BUNDLE20" helpText="Customers enter this at checkout" autoComplete="off" />
                )}
                <TextField label="Title" value={form.title} onChange={(v) => set("title", v)} placeholder="e.g., Bundle & Save" helpText="Internal name shown in your discounts list" autoComplete="off" />
              </BlockStack>
            </Card>

            <div className="bb-bundles" style={{ position: "relative", zIndex: 10 }}>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">Bundles</Text>
                <Text variant="bodyMd" tone="subdued">Each bundle defines required products and the discount customers receive. If multiple bundles qualify, the highest discount applies.</Text>
              </BlockStack>

              {bundles.map((bundle, bundleIndex) => (
                <div key={bundle.id} style={{ position: "relative", zIndex: bundles.length - bundleIndex }}>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="info">Bundle {bundleIndex + 1}</Badge>
                        {bundle.label && <Text variant="bodyMd" fontWeight="semibold">{bundle.label}</Text>}
                      </InlineStack>
                      {bundles.length > 1 && (
                        <Button variant="plain" tone="critical" icon={DeleteIcon} onClick={() => removeBundle(bundle.id)} accessibilityLabel="Remove bundle" />
                      )}
                    </InlineStack>

                    <TextField label="Bundle name (optional)" value={bundle.label} onChange={(v) => updateBundle(bundle.id, "label", v)} placeholder="e.g., Bottle + Lid deal" helpText="Shown to customer in discount message" autoComplete="off" />

                    <Divider />

                    <BlockStack gap="300">
                      <Text as="p" variant="bodyMd" fontWeight="medium">Discount</Text>
                      <ChoiceList title="Discount type" titleHidden choices={[{ label: "Percentage off bundle items", value: "percentage" }, { label: "Fixed amount off each bundle item", value: "fixed" }]} selected={bundle.discountType} onChange={(v) => updateBundle(bundle.id, "discountType", v)} />
                      <InlineStack gap="300" wrap>
                        <Box maxWidth="180px">
                          <TextField label={bundle.discountType[0] === "percentage" ? "Percentage off (%)" : "Amount off ($)"} type="number" value={bundle.discountValue} onChange={(v) => updateBundle(bundle.id, "discountValue", v)} prefix={bundle.discountType[0] === "fixed" ? "$" : undefined} suffix={bundle.discountType[0] === "percentage" ? "%" : undefined} min={0} max={bundle.discountType[0] === "percentage" ? 100 : undefined} autoComplete="off" />
                        </Box>
                        <Box maxWidth="220px">
                          <TextField label="Max bundles per order" type="number" value={bundle.maxBundles} onChange={(v) => updateBundle(bundle.id, "maxBundles", v)} min={1} autoComplete="off" helpText="Leave empty for unlimited" />
                        </Box>
                      </InlineStack>
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="300">
                      <Text as="p" variant="bodyMd" fontWeight="medium">Required items</Text>
                      <Text variant="bodySm" tone="subdued">All of these must be in the customer's cart to trigger this bundle.</Text>

                      {bundle.items.map((item, itemIndex) => (
                        <BlockStack key={item.id} gap="200">
                          {itemIndex > 0 && (
                            <InlineStack gap="200" blockAlign="center">
                              <div style={{ flex: 1, height: 1, background: "var(--p-color-border-subdued)" }} />
                              <Text variant="bodySm" tone="subdued">AND</Text>
                              <div style={{ flex: 1, height: 1, background: "var(--p-color-border-subdued)" }} />
                            </InlineStack>
                          )}
                          <InlineStack gap="300" blockAlign="start" wrap={false}>
                            <Box style={{ flex: 1, minWidth: 0 }}>
                              <ItemPicker
                                pickerType={item.pickerType}
                                onPickerTypeChange={(t) => { updateItem(bundle.id, item.id, "pickerType", t); updateItem(bundle.id, item.id, "selected", null); updateItem(bundle.id, item.id, "searchQuery", ""); updateItem(bundle.id, item.id, "results", []); }}
                                selected={item.selected}
                                onSelect={(v) => updateItem(bundle.id, item.id, "selected", v)}
                                searchQuery={item.searchQuery}
                                onSearchChange={(v) => {
                                  updateItem(bundle.id, item.id, "searchQuery", v);
                                  if (!v) { updateItem(bundle.id, item.id, "results", []); return; }
                                  const timer = setTimeout(() => triggerSearch(bundle.id, item.id, item.pickerType, v), 400);
                                }}
                                results={item.results}
                                isSearching={item.isSearching}
                                hasNextPage={item.hasNextPage}
                                isLoadingMore={item.isLoadingMore}
                                onLoadMore={() => { if (item.hasNextPage && !item.isLoadingMore && item.endCursor) loadMoreSearch(bundle.id, item.id, item.pickerType, item.searchQuery, item.endCursor); }}
                              />
                            </Box>
                            <Box minWidth="120px">
                              <TextField label="Min qty" type="number" value={item.minQty} onChange={(v) => updateItem(bundle.id, item.id, "minQty", v)} min={1} autoComplete="off" />
                            </Box>
                            {bundle.items.length > 1 && (
                              <Box paddingBlockStart="600">
                                <Button variant="plain" tone="critical" icon={DeleteIcon} onClick={() => removeItem(bundle.id, item.id)} accessibilityLabel="Remove item" />
                              </Box>
                            )}
                          </InlineStack>
                        </BlockStack>
                      ))}

                      <Box>
                        <Button variant="plain" icon={PlusIcon} onClick={() => addItem(bundle.id)}>Add another product / collection</Button>
                      </Box>
                    </BlockStack>
                  </BlockStack>
                </Card>
                </div>
              ))}

              <div className="bb-add-bundle">
                <Button icon={PlusIcon} onClick={addBundle}>Add another bundle</Button>
              </div>
            </BlockStack>
            </div>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px"><DateTimePicker label="Start date" value={form.startDateTime} onChange={(v) => set("startDateTime", v)} /></Box>
                  <Box minWidth="300px"><DateTimePicker label="End date (optional)" value={form.endDateTime} onChange={(v) => set("endDateTime", v)} helpText="Leave empty for no end date" /></Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {form.discountType[0] === "code" && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Usage limits</Text>
                  <TextField label="Total number of uses (optional)" type="number" value={form.usageLimit} onChange={(v) => set("usageLimit", v)} min={1} helpText="Leave empty for unlimited" autoComplete="off" />
                  <Checkbox label="Limit to one use per customer" checked={form.appliesOncePerCustomer} onChange={(v) => set("appliesOncePerCustomer", v)} />
                </BlockStack>
              </Card>
            )}

            <InlineStack align="end">
              <Button variant="primary" onClick={handleSubmit} loading={isSubmitting} disabled={!functionId}>
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
