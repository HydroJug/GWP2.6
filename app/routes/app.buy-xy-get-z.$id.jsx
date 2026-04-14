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
  Thumbnail,
  Divider,
  ChoiceList,
  Checkbox,
  Badge,
} from "@shopify/polaris";
import DateTimePicker from "../components/DateTimePicker";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const isNew = params.id === "new";

  const fnRes = await admin.graphql(
    `query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`
  );
  const fnData = await fnRes.json();
  const allMatches = fnData.data?.shopifyFunctions?.nodes?.filter(
    (f) => (f.title === "Buy X, Buy Y, Get Z Free" || f.title === "Buy X Buy Y Get Z") && f.apiType === "discount"
  ) ?? [];
  console.log("[BuyXYGetZ] ALL matching functions:", JSON.stringify(allMatches));
  const fn = allMatches[allMatches.length - 1];
  const functionId = fn?.id ?? null;

  if (isNew) {
    return json({ functionId, discount: null, isNew: true });
  }

  // Load existing discount for editing.
  // Two entry paths exist:
  //   1. From the in-app list  → full GID, e.g. gid://shopify/DiscountAutomaticNode/123
  //   2. From Shopify's native discount admin → bare numeric ID, e.g. "123"
  // Normalise to full GIDs before querying.
  const rawId = params.id;
  let automaticGid, codeGid;

  if (rawId.startsWith("gid://shopify/DiscountAutomaticNode/")) {
    automaticGid = rawId;
    codeGid = null;
  } else if (rawId.startsWith("gid://shopify/DiscountCodeNode/")) {
    automaticGid = null;
    codeGid = rawId;
  } else {
    // Plain numeric ID from Shopify's discount admin — try both.
    automaticGid = `gid://shopify/DiscountAutomaticNode/${rawId}`;
    codeGid = `gid://shopify/DiscountCodeNode/${rawId}`;
  }

  let d, config, resolvedGid;

  if (automaticGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        automaticDiscountNode(id: $id) {
          id
          metafield(namespace: "buy_xy_get_z", key: "config") { value }
          automaticDiscount {
            ... on DiscountAutomaticApp {
              discountId title status startsAt endsAt
            }
          }
        }
      }`,
      { variables: { id: automaticGid } }
    );
    const data = await res.json();
    const node = data.data?.automaticDiscountNode;
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
          metafield(namespace: "buy_xy_get_z", key: "config") { value }
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
    const data = await res.json();
    const node = data.data?.codeDiscountNode;
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
      nodeId: resolvedGid,
      discountId: d.discountId,
      discountType: resolvedGid?.includes("DiscountAutomaticNode") ? "automatic" : "code",
      title: d.title,
      code: d.codes?.edges?.[0]?.node?.code ?? "",
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      usageLimit: d.usageLimit?.toString() ?? "",
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? false,
      xType: config.xType ?? "collection",
      xId: config.xId ?? null,
      xLabel: config.xLabel ?? null,
      xImage: config.xImage ?? null,
      yType: config.yType ?? "collection",
      yId: config.yId ?? null,
      yLabel: config.yLabel ?? null,
      yImage: config.yImage ?? null,
      zType: config.zType ?? "collection",
      zId: config.zId ?? null,
      zLabel: config.zLabel ?? null,
      zImage: config.zImage ?? null,
      minQuantityX: config.minQuantityX?.toString() ?? "1",
      minQuantityY: config.minQuantityY?.toString() ?? "1",
      maxFreeQty: config.maxFreeQty?.toString() ?? "1",
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
  const xType = formData.get("xType");
  const xId = formData.get("xId");
  const xLabel = formData.get("xLabel");
  const xImage = formData.get("xImage") || null;
  const yType = formData.get("yType");
  const yId = formData.get("yId");
  const yLabel = formData.get("yLabel");
  const yImage = formData.get("yImage") || null;
  const zType = formData.get("zType");
  const zId = formData.get("zId");
  const zLabel = formData.get("zLabel");
  const zImage = formData.get("zImage") || null;
  const minQuantityX = parseInt(formData.get("minQuantityX") || "1", 10);
  const minQuantityY = parseInt(formData.get("minQuantityY") || "1", 10);
  const maxFreeQty = parseInt(formData.get("maxFreeQty") || "1", 10);
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const functionId = formData.get("functionId");

  if (!functionId) return json({ error: "Buy X Buy Y Get Z function is not deployed yet." });
  if (!xId || !yId || !zId) return json({ error: "Please select a product or collection for all three slots." });

  const config = {
    title,
    minQuantityX,
    minQuantityY,
    maxFreeQty,
    xLabel, yLabel, zLabel,
    xType, xId, xImage,
    yType, yId, yImage,
    zType, zId, zImage,
  };

  const variablesData = {
    collX: xType === "collection" ? [xId] : null,
    collY: yType === "collection" ? [yId] : null,
    collZ: zType === "collection" ? [zId] : null,
  };

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;
  const configJson = JSON.stringify(config);
  const variablesJson = JSON.stringify(variablesData);

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
          `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount { discountId }
              userErrors { field message code }
            }
          }`,
          { variables: { id: discountId, automaticAppDiscount: discountInput } }
        );
        const data = await response.json();
        const errors = data.data?.discountAutomaticAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
      } else {
        const response = await admin.graphql(
          `mutation discountCodeAppUpdate($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
            discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
              codeAppDiscount { discountId }
              userErrors { field message code }
            }
          }`,
          { variables: { id: discountId, codeAppDiscount: { ...discountInput, usageLimit: usageLimit ? parseInt(usageLimit, 10) : null, appliesOncePerCustomer } } }
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
          `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount { discountId }
              userErrors { field message code }
            }
          }`,
          { variables: { automaticAppDiscount: discountInput } }
        );
        const data = await response.json();
        const errors = data.data?.discountAutomaticAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
      } else {
        const response = await admin.graphql(
          `mutation discountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
              codeAppDiscount { discountId }
              userErrors { field message code }
            }
          }`,
          { variables: { codeAppDiscount: { ...discountInput, code } } }
        );
        const data = await response.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
        createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
      }
    }

    if (!createdDiscountId) return json({ error: "Discount created but no ID returned." });

    // Set metafield via metafieldsSet — this auto-creates the definition
    const nodeId = createdDiscountId.replace("DiscountAutomaticApp", "DiscountAutomaticNode")
      .replace("DiscountCodeApp", "DiscountCodeNode");

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
            { ownerId: nodeId, namespace: "buy_xy_get_z", key: "config", type: "json", value: configJson },
            { ownerId: nodeId, namespace: "buy_xy_get_z", key: "variables", type: "json", value: variablesJson },
          ],
        },
      }
    );
    const metafieldsSetData = await metafieldsSetRes.json();
    const mfErrors = metafieldsSetData.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) {
      console.log("[BuyXYGetZ] metafieldsSet errors:", JSON.stringify(mfErrors));
      return json({ error: "Discount saved but config failed: " + mfErrors[0].message });
    }
    console.log("[BuyXYGetZ Action] metafields saved on", nodeId);

    return json({ success: true });
  } catch (err) {
    console.log("[BuyXYGetZ Action] ERROR:", err.message);
    return json({ error: err.message });
  }
};

// ── Slot Picker ───────────────────────────────────────────────────────────────

function SlotPicker({ label, helpText, pickerType, onPickerTypeChange, selected, onSelect, shopify }) {
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
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="medium">{label}</Text>
        <ChoiceList
          title=""
          titleHidden
          choices={[
            { label: "Collection", value: "collection" },
            { label: "Specific product", value: "product" },
          ]}
          selected={[pickerType]}
          onChange={([v]) => { onPickerTypeChange(v); onSelect(null); }}
        />
      </BlockStack>
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
      {helpText && <Text variant="bodySm" tone="subdued">{helpText}</Text>}
    </BlockStack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const slots = ["x", "y", "z"];

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildEmptyForm() {
  return { discountType: ["automatic"], code: "", title: "", minQuantityX: "1", minQuantityY: "1", maxFreeQty: "1", startDateTime: nowLocal(), endDateTime: "", usageLimit: "1", appliesOncePerCustomer: true };
}

function buildFormFromDiscount(d) {
  return { discountType: [d.discountType], code: d.code, title: d.title, minQuantityX: d.minQuantityX, minQuantityY: d.minQuantityY, maxFreeQty: d.maxFreeQty ?? "1", startDateTime: d.startsAt, endDateTime: d.endsAt, usageLimit: d.usageLimit, appliesOncePerCustomer: d.appliesOncePerCustomer };
}

function buildSelectedFromDiscount(d) {
  const make = (id, label, image) => id ? { id, title: label ?? id, image: image ?? null } : null;
  return { x: make(d.xId, d.xLabel, d.xImage), y: make(d.yId, d.yLabel, d.yImage), z: make(d.zId, d.zLabel, d.zImage) };
}

export default function BuyXYGetZForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isEditing = !isNew && !!discount;
  const pageTitle = isEditing ? "Edit discount" : "Create discount";

  const [form, setForm] = useState(() => isEditing ? buildFormFromDiscount(discount) : buildEmptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [pickerType, setPickerType] = useState(() => isEditing ? { x: discount.xType, y: discount.yType, z: discount.zType } : { x: "collection", y: "collection", z: "collection" });
  const [selected, setSelected] = useState(() => isEditing ? buildSelectedFromDiscount(discount) : { x: null, y: null, z: null });

  const set = useCallback((field, value) => setForm((f) => ({ ...f, [field]: value })), []);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      shopify.toast.show(isEditing ? "Discount saved!" : "Discount created!");
      if (!isEditing) {
        setForm(buildEmptyForm());
        setSelected({ x: null, y: null, z: null });
      }
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing]);

  const handleSubmit = useCallback(() => {
    if (!selected.x || !selected.y || !selected.z) { shopify.toast.show("Please select a product or collection for all three slots.", { isError: true }); return; }
    if (!form.title.trim()) { shopify.toast.show("Title is required.", { isError: true }); return; }
    if (form.discountType[0] === "code" && !form.code.trim()) { shopify.toast.show("Discount code is required.", { isError: true }); return; }
    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) { data.append("discountId", discount.discountId); }
    data.append("discountType", form.discountType[0]);
    data.append("code", form.code);
    data.append("title", form.title);
    slots.forEach((s) => {
      data.append(`${s}Type`, pickerType[s]);
      data.append(`${s}Id`, selected[s].id);
      data.append(`${s}Label`, selected[s].title);
      data.append(`${s}Image`, selected[s].image ?? "");
    });
    data.append("minQuantityX", form.minQuantityX);
    data.append("minQuantityY", form.minQuantityY);
    data.append("maxFreeQty", form.maxFreeQty);
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("usageLimit", form.usageLimit);
    data.append("appliesOncePerCustomer", String(form.appliesOncePerCustomer));
    data.append("functionId", functionId ?? "");
    fetcher.submit(data, { method: "POST" });
  }, [form, selected, pickerType, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) {
    return (
      <Page backAction={{ content: "All discounts", url: "/app/buy-xy-get-z" }} title="Discount not found">
        <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
      </Page>
    );
  }

  const slotConfig = {
    x: { label: "Required product / collection X", help: "Customer needs the minimum quantity of this in their cart." },
    y: { label: "Required product / collection Y", help: "Customer also needs the minimum quantity of this." },
    z: { label: "Free gift (Z)", help: "Matching items in cart will be made free when X and Y are met." },
  };

  return (
    <Page backAction={{ content: "All discounts", url: "/app/buy-xy-get-z" }} title={pageTitle}>
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">The Buy X Buy Y Get Z function is not deployed yet. Run <code>shopify app deploy</code>, then refresh.</Text>
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
                  <TextField label="Discount code" value={form.code} onChange={(v) => set("code", v)} placeholder="e.g., FREEGIFT" helpText="Customers enter this at checkout" autoComplete="off" />
                )}
                <TextField label="Title" value={form.title} onChange={(v) => set("title", v)} placeholder="e.g., Buy Bottle + Lid, Get Cap Free" helpText="Internal name shown in your discounts list" autoComplete="off" />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Product requirements</Text>
                  <Text variant="bodySm" tone="subdued">The customer must meet the minimum quantity of X and Y to unlock the free gift Z.</Text>
                </BlockStack>

                <SlotPicker label={slotConfig.x.label} helpText={slotConfig.x.help} pickerType={pickerType.x} onPickerTypeChange={(t) => setPickerType((p) => ({ ...p, x: t }))} selected={selected.x} onSelect={(v) => setSelected((s) => ({ ...s, x: v }))} shopify={shopify} />
                <Box maxWidth="180px">
                  <TextField label="Minimum quantity of X" type="number" value={form.minQuantityX} onChange={(v) => set("minQuantityX", v)} min={1} autoComplete="off" />
                </Box>

                <Divider />

                <SlotPicker label={slotConfig.y.label} helpText={slotConfig.y.help} pickerType={pickerType.y} onPickerTypeChange={(t) => setPickerType((p) => ({ ...p, y: t }))} selected={selected.y} onSelect={(v) => setSelected((s) => ({ ...s, y: v }))} shopify={shopify} />
                <Box maxWidth="180px">
                  <TextField label="Minimum quantity of Y" type="number" value={form.minQuantityY} onChange={(v) => set("minQuantityY", v)} min={1} autoComplete="off" />
                </Box>

                <Divider />

                <SlotPicker label={slotConfig.z.label} helpText={slotConfig.z.help} pickerType={pickerType.z} onPickerTypeChange={(t) => setPickerType((p) => ({ ...p, z: t }))} selected={selected.z} onSelect={(v) => setSelected((s) => ({ ...s, z: v }))} shopify={shopify} />
                <Box maxWidth="180px">
                  <TextField label="Max free gifts" type="number" value={form.maxFreeQty} onChange={(v) => set("maxFreeQty", v)} min={1} autoComplete="off" helpText="Maximum number of free Z items per cart" />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px"><DateTimePicker label="Start date" value={form.startDateTime} onChange={(v) => set("startDateTime", v)} /></Box>
                  <Box minWidth="300px"><DateTimePicker label="End date (optional)" value={form.endDateTime} onChange={(v) => set("endDateTime", v)} helpText="Leave empty for no end date" /></Box>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Usage limits</Text>
                  <Text variant="bodySm" tone="subdued">Defaults to one use total and one use per customer.</Text>
                </BlockStack>
                {form.discountType[0] === "code" && (
                  <TextField label="Total number of uses (optional)" type="number" value={form.usageLimit} onChange={(v) => set("usageLimit", v)} min={1} helpText="Leave empty for unlimited uses" autoComplete="off" />
                )}
                <Checkbox label="Limit to one use per customer" checked={form.appliesOncePerCustomer} onChange={(v) => set("appliesOncePerCustomer", v)} />
              </BlockStack>
            </Card>

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
