import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState, useEffect, useCallback } from "react";
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
} from "@shopify/polaris";
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
  };

  const metafields = [{ namespace: "combined_discount", key: "config", type: "json", value: JSON.stringify(config) }];
  const discountClasses = ["ORDER", "SHIPPING"];

  try {
    let response;
    if (!isNew && discountId) {
      if (discountType === "automatic") {
        response = await admin.graphql(
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
      } else {
        response = await admin.graphql(
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
      }
    } else {
      if (discountType === "automatic") {
        response = await admin.graphql(
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
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
      } else {
        response = await admin.graphql(
          `mutation($d: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $d) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          { variables: { d: { title, code, functionId, startsAt, ...(endsAt ? { endsAt } : {}), discountClasses, usageLimit: usageLimit ? parseInt(usageLimit) : null, appliesOncePerCustomer, metafields } } }
        );
        const data = await response.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        if (data.errors) return json({ error: data.errors[0].message });
      }
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
  return { discountType: ["code"], code: "", title: "", discountValueType: ["percentage"], discountValue: "", minimumOrderAmount: "", startDateTime: nowLocal(), endDateTime: "", usageLimit: "", appliesOncePerCustomer: false, includesFreeShipping: false, freeShippingMinimum: "", maxShippingCost: "" };
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
  };
}

export default function CombinedDiscountForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isEditing = !isNew && !!discount;

  const [form, setForm] = useState(() => isEditing ? buildFromDiscount(discount) : buildEmpty());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const set = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);

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
    fetcher.submit(data, { method: "POST" });
  }, [form, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) return (
    <Page backAction={{ content: "All discounts", url: "/app/combined-discount" }} title="Not found">
      <Banner tone="critical"><Text>This discount could not be found.</Text></Banner>
    </Page>
  );

  const valueLabel = form.discountValueType[0] === "percentage" ? "Percentage off (%)" : "Fixed amount off ($)";
  const pageTitle = isEditing ? "Edit discount" : "Create discount";

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
