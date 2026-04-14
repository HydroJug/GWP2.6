import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState, useEffect, useCallback } from "react";
import { useAppBridge, TitleBar } from "@shopify/app-bridge-react";
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
  Thumbnail,
  Divider,
} from "@shopify/polaris";
import { PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
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
    (f) => f.apiType === "discount" && f.title === "Buy More Save More"
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
          metafield(namespace: "buy_more_save_more", key: "config") { value }
          automaticDiscount {
            ... on DiscountAutomaticApp { discountId title status startsAt endsAt }
          }
        }
      }`,
      { variables: { id: automaticGid } }
    );
    const node = (await res.json()).data?.automaticDiscountNode;
    if (node) {
      d = { ...node.automaticDiscount, codes: null };
      config = node.metafield?.value ? JSON.parse(node.metafield.value) : {};
      resolvedGid = automaticGid;
    }
  }

  if (!d && codeGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          metafield(namespace: "buy_more_save_more", key: "config") { value }
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
    if (node) {
      d = node.codeDiscount;
      config = node.metafield?.value ? JSON.parse(node.metafield.value) : {};
      resolvedGid = codeGid;
    }
  }

  if (!d) return json({ functionId, discount: null, isNew: false, notFound: true });

  return json({
    functionId,
    isNew: false,
    discount: {
      discountId: d.discountId,
      discountType: resolvedGid?.includes("DiscountAutomaticNode") ? "automatic" : "code",
      title: d.title,
      code: d.codes?.edges?.[0]?.node?.code ?? "",
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      usageLimit: d.usageLimit?.toString() ?? "",
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? false,
      targetType: config.targetType ?? "collection",
      targetId: config.targetId ?? null,
      targetLabel: config.targetLabel ?? null,
      targetImage: config.targetImage ?? null,
      tiers: config.tiers ?? [
        { minQty: "1", discountValue: "0", discountType: "percentage" },
        { minQty: "3", discountValue: "5", discountType: "percentage" },
        { minQty: "6", discountValue: "10", discountType: "percentage" },
      ],
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

async function fetchCollectionProductIds(admin, collectionId) {
  const ids = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const res = await admin.graphql(
      `query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id }
          }
        }
      }`,
      { variables: { id: collectionId, cursor } }
    );
    const data = await res.json();
    const prods = data.data?.collection?.products;
    if (!prods) break;
    ids.push(...prods.nodes.map((n) => n.id));
    hasNext = prods.pageInfo.hasNextPage;
    cursor = prods.pageInfo.endCursor;
  }
  return ids;
}

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const isNew = params.id === "new";
  const discountId = formData.get("discountId");
  const discountType = formData.get("discountType") ?? "automatic";
  const code = formData.get("code")?.trim();
  const title = formData.get("title")?.trim();
  const targetType = formData.get("targetType");
  const targetId = formData.get("targetId");
  const targetLabel = formData.get("targetLabel");
  const targetImage = formData.get("targetImage") || null;
  const tiersJson = formData.get("tiers");
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const functionId = formData.get("functionId");

  if (!functionId) return json({ error: "Buy More Save More function is not deployed yet." });
  if (!targetId) return json({ error: "Please select a product or collection." });

  let tiers;
  try {
    tiers = JSON.parse(tiersJson);
  } catch {
    return json({ error: "Invalid tiers configuration." });
  }

  if (!tiers.length) return json({ error: "At least one price tier is required." });

  const validTiers = tiers.filter(
    (t) => parseInt(t.minQty, 10) > 0 && parseFloat(t.discountValue) > 0
  );
  if (!validTiers.length) return json({ error: "At least one tier must have a quantity and discount value greater than 0." });

  // Resolve product IDs for the target
  let productIds;
  if (targetType === "product") {
    productIds = [targetId];
  } else {
    productIds = await fetchCollectionProductIds(admin, targetId);
    if (!productIds.length) return json({ error: "The selected collection has no products." });
  }

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;

  const config = {
    targetType,
    targetId,
    targetLabel,
    targetImage,
    productIds,
    tiers: tiers.map((t) => ({
      minQty: parseInt(t.minQty, 10),
      discountValue: t.discountValue,
      discountType: t.discountType,
    })),
  };

  const discountInput = {
    title,
    functionId,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    discountClasses: ["PRODUCT"],
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
  };

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
          { variables: { id: discountId, d: { ...discountInput, usageLimit: usageLimit ? parseInt(usageLimit, 10) : null, appliesOncePerCustomer } } }
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
          { variables: { d: { ...discountInput, code } } }
        );
        const data = await response.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
      }
    }

    if (!createdDiscountId) return json({ error: "Discount created but no ID returned." });

    const nodeId = createdDiscountId
      .replace("DiscountAutomaticApp", "DiscountAutomaticNode")
      .replace("DiscountCodeApp", "DiscountCodeNode");

    const metafieldsSetRes = await admin.graphql(
      `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { namespace key }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            { ownerId: nodeId, namespace: "buy_more_save_more", key: "config", type: "json", value: JSON.stringify(config) },
          ],
        },
      }
    );
    const mfData = await metafieldsSetRes.json();
    const mfErrors = mfData.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) console.log("[BuyMoreSaveMore] metafieldsSet errors:", JSON.stringify(mfErrors));

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message });
  }
};

// ── Target Picker ─────────────────────────────────────────────────────────────

function TargetPicker({ pickerType, onPickerTypeChange, selected, onSelect, shopify }) {
  const openPicker = useCallback(async () => {
    const type = pickerType === "collection" ? "collection" : "product";
    const result = await shopify.resourcePicker({ type, multiple: false, selectionIds: selected ? [{ id: selected.id }] : [] });
    if (result && result.length > 0) {
      const item = result[0];
      onSelect({
        id: item.id,
        title: item.title,
        image: type === "collection" ? (item.image?.originalSrc ?? null) : (item.images?.[0]?.originalSrc ?? null),
      });
    }
  }, [pickerType, selected, shopify, onSelect]);

  return (
    <BlockStack gap="300">
      <ChoiceList
        title="Target type"
        choices={[
          { label: "Collection", value: "collection" },
          { label: "Specific product", value: "product" },
        ]}
        selected={[pickerType]}
        onChange={([v]) => { onPickerTypeChange(v); onSelect(null); }}
      />
      <Button onClick={openPicker}>
        {selected ? `Change ${pickerType}` : `Browse ${pickerType === "collection" ? "collections" : "products"}`}
      </Button>
      {selected && (
        <InlineStack gap="300" align="start" blockAlign="center">
          {selected.image
            ? <Thumbnail source={selected.image} alt={selected.title} size="small" />
            : <Box width="40px" minHeight="40px" background="bg-surface-secondary" borderRadius="100" />
          }
          <Text variant="bodyMd" fontWeight="semibold">{selected.title}</Text>
          <Button variant="plain" tone="critical" onClick={() => onSelect(null)}>Remove</Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

// ── Tier Row ──────────────────────────────────────────────────────────────────

function TierRow({ tier, index, onChange, onRemove, isOnly }) {
  return (
    <InlineStack gap="300" blockAlign="end" wrap={false}>
      <Box minWidth="120px">
        <TextField
          label={index === 0 ? "Min quantity" : " "}
          labelHidden={index > 0}
          type="number"
          value={tier.minQty}
          onChange={(v) => onChange(index, "minQty", v)}
          min={1}
          autoComplete="off"
          prefix="≥"
        />
      </Box>
      <Box minWidth="120px">
        <TextField
          label={index === 0 ? "Discount" : " "}
          labelHidden={index > 0}
          type="number"
          value={tier.discountValue}
          onChange={(v) => onChange(index, "discountValue", v)}
          min={0}
          max={tier.discountType === "percentage" ? 100 : undefined}
          suffix={tier.discountType === "percentage" ? "%" : undefined}
          prefix={tier.discountType === "amount" ? "$" : undefined}
          autoComplete="off"
        />
      </Box>
      <Box minWidth="160px">
        <ChoiceList
          title={index === 0 ? "Type" : " "}
          titleHidden={index > 0}
          choices={[
            { label: "% off", value: "percentage" },
            { label: "$ off each", value: "amount" },
          ]}
          selected={[tier.discountType]}
          onChange={(v) => onChange(index, "discountType", v[0])}
        />
      </Box>
      <Box paddingBlockStart={index === 0 ? "800" : "0"}>
        <Button
          variant="plain"
          tone="critical"
          icon={DeleteIcon}
          onClick={() => onRemove(index)}
          disabled={isOnly}
          accessibilityLabel="Remove tier"
        />
      </Box>
    </InlineStack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const DEFAULT_TIERS = [
  { minQty: "1", discountValue: "0", discountType: "percentage" },
  { minQty: "3", discountValue: "5", discountType: "percentage" },
  { minQty: "6", discountValue: "10", discountType: "percentage" },
];

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
  };
}

function buildFromDiscount(d) {
  return {
    discountType: [d.discountType],
    code: d.code,
    title: d.title,
    startDateTime: d.startsAt,
    endDateTime: d.endsAt,
    usageLimit: d.usageLimit,
    appliesOncePerCustomer: d.appliesOncePerCustomer,
  };
}

export default function BuyMoreSaveMoreForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;
  const pageTitle = isEditing ? "Edit discount" : "Create discount";

  const [form, setForm] = useState(() => isEditing ? buildFromDiscount(discount) : buildEmpty());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);

  // Target picker state
  const [pickerType, setPickerType] = useState(isEditing ? (discount.targetType ?? "collection") : "collection");
  const [selected, setSelected] = useState(() => {
    if (isEditing && discount.targetId) {
      return { id: discount.targetId, title: discount.targetLabel ?? discount.targetId, image: discount.targetImage ?? null };
    }
    return null;
  });
  // Tiers state
  const [tiers, setTiers] = useState(() => {
    if (isEditing && discount.tiers?.length) {
      return discount.tiers.map((t) => ({
        minQty: String(t.minQty),
        discountValue: String(t.discountValue),
        discountType: t.discountType ?? "percentage",
      }));
    }
    return DEFAULT_TIERS;
  });

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      shopify.toast.show(isEditing ? "Discount saved!" : "Discount created!");
      if (!isEditing) {
        setForm(buildEmpty());
        setSelected(null);
        setTiers(DEFAULT_TIERS);
      }
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing]);

  const handleTierChange = useCallback((idx, field, value) => {
    setTiers((prev) => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  }, []);

  const handleAddTier = useCallback(() => {
    setTiers((prev) => [...prev, { minQty: "", discountValue: "", discountType: "percentage" }]);
  }, []);

  const handleRemoveTier = useCallback((idx) => {
    setTiers((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!selected) { shopify.toast.show("Please select a product or collection.", { isError: true }); return; }
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (form.discountType[0] === "code" && !form.code.trim()) { shopify.toast.show("Discount code is required.", { isError: true }); return; }
    if (!tiers.length) { shopify.toast.show("At least one tier is required.", { isError: true }); return; }

    const hasValidTier = tiers.some((t) => parseInt(t.minQty, 10) > 0 && parseFloat(t.discountValue) > 0);
    if (!hasValidTier) { shopify.toast.show("At least one tier must have a quantity and discount greater than 0.", { isError: true }); return; }

    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("discountType", form.discountType[0]);
    data.append("code", form.code);
    data.append("title", form.title);
    data.append("targetType", pickerType);
    data.append("targetId", selected.id);
    data.append("targetLabel", selected.title);
    data.append("targetImage", selected.image ?? "");
    data.append("tiers", JSON.stringify(tiers));
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("functionId", functionId ?? "");
    fetcher.submit(data, { method: "POST" });
  }, [form, tiers, selected, pickerType, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) return (
    <Page backAction={{ content: "All discounts", url: "/app/buy-more-save-more" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  return (
    <Page backAction={{ content: "All discounts", url: "/app/buy-more-save-more" }} title={pageTitle}>
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Buy More Save More function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount details</Text>
                <ChoiceList
                  title="Discount type"
                  choices={[
                    { label: "Automatic discount", value: "automatic" },
                    { label: "Discount code", value: "code" },
                  ]}
                  selected={form.discountType}
                  onChange={(v) => set("discountType", v)}
                />
                {form.discountType[0] === "code" && (
                  <TextField
                    label="Discount code"
                    value={form.code}
                    onChange={(v) => set("code", v)}
                    placeholder="e.g., BUYMORE10"
                    helpText="Customers enter this at checkout"
                    autoComplete="off"
                  />
                )}
                <TextField
                  label="Title"
                  value={form.title}
                  onChange={(v) => set("title", v)}
                  placeholder="e.g., Buy More, Save More — Apparel"
                  helpText="Internal name shown in your discounts list"
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Eligible products</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Select the product or collection that qualifies for tiered pricing.
                    {pickerType === "collection" && " Product IDs are resolved when you save — re-save if you add products to the collection later."}
                  </Text>
                </BlockStack>
                <TargetPicker
                  pickerType={pickerType}
                  onPickerTypeChange={(v) => { setPickerType(v); setSelected(null); }}
                  selected={selected}
                  onSelect={setSelected}
                  shopify={shopify}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Price tiers</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Define quantity thresholds. The highest qualifying tier is applied automatically.
                    Set a tier to 0% or $0 for a "no discount" baseline row.
                  </Text>
                </BlockStack>

                <BlockStack gap="300">
                  {tiers.map((tier, idx) => (
                    <TierRow
                      key={idx}
                      tier={tier}
                      index={idx}
                      onChange={handleTierChange}
                      onRemove={handleRemoveTier}
                      isOnly={tiers.length === 1}
                    />
                  ))}
                </BlockStack>

                <Box>
                  <Button icon={PlusIcon} onClick={handleAddTier}>Add tier</Button>
                </Box>

                <Divider />

                <Text as="p" variant="bodySm" tone="subdued">
                  Example: ≥1 unit → 0% off, ≥3 units → 5% off, ≥6 units → 10% off.
                  A customer buying 4 items gets 5% off all qualifying items in their cart.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px">
                    <DateTimePicker label="Start date" value={form.startDateTime} onChange={(v) => set("startDateTime", v)} />
                  </Box>
                  <Box minWidth="300px">
                    <DateTimePicker label="End date (optional)" value={form.endDateTime} onChange={(v) => set("endDateTime", v)} helpText="Leave empty for no end date" />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {form.discountType[0] === "code" && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Usage limits</Text>
                  <TextField
                    label="Maximum number of uses (optional)"
                    type="number"
                    value={form.usageLimit}
                    onChange={(v) => set("usageLimit", v)}
                    min={0}
                    helpText="Leave empty for unlimited"
                    autoComplete="off"
                  />
                </BlockStack>
              </Card>
            )}

            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
                disabled={isSubmitting || !functionId}
              >
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
