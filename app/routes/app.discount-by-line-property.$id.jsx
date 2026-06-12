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
  Checkbox,
} from "@shopify/polaris";
import DateTimePicker from "../components/DateTimePicker";

const FUNCTION_TITLE = "Discount by Line Item Property";
const NAMESPACE = "line_property_discount";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const isNew = params.id === "new";

  const fnRes = await admin.graphql(
    `query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`
  );
  const fnData = await fnRes.json();
  const allMatches =
    fnData.data?.shopifyFunctions?.nodes?.filter(
      (f) => f.title === FUNCTION_TITLE && f.apiType === "discount"
    ) ?? [];
  const fn = allMatches[allMatches.length - 1];
  const functionId = fn?.id ?? null;

  if (isNew) {
    return json({ functionId, discount: null, isNew: true });
  }

  // Normalise the incoming id to a full automatic-discount GID.
  const rawId = params.id;
  const automaticGid = rawId.startsWith("gid://shopify/DiscountAutomaticNode/")
    ? rawId
    : `gid://shopify/DiscountAutomaticNode/${rawId}`;

  const res = await admin.graphql(
    `query GetDiscount($id: ID!) {
      automaticDiscountNode(id: $id) {
        id
        metafield(namespace: "${NAMESPACE}", key: "config") { value }
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

  if (!node || !node.automaticDiscount) {
    return json({ functionId, discount: null, isNew: false, notFound: true });
  }

  const d = node.automaticDiscount;
  const config = node.metafield?.value ? JSON.parse(node.metafield.value) : {};

  return json({
    functionId,
    isNew: false,
    discount: {
      nodeId: automaticGid,
      discountId: d.discountId,
      title: d.title,
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      propertyKey: config.propertyKey ?? "",
      valueType: config.valueType ?? "percentage",
      amount: config.amount?.toString() ?? "",
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const isNew = params.id === "new";
  const discountId = formData.get("discountId");
  const title = formData.get("title")?.trim();
  const propertyKey = formData.get("propertyKey")?.trim();
  const valueType = formData.get("valueType");
  const amount = parseFloat(formData.get("amount") || "0");
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const functionId = formData.get("functionId");

  if (!functionId)
    return json({ error: "The Discount by Line Item Property function is not deployed yet." });
  if (!title) return json({ error: "Title is required." });
  if (!propertyKey) return json({ error: "Line item property key is required." });
  if (!(amount > 0)) return json({ error: "Discount value must be greater than zero." });
  if (valueType === "percentage" && amount > 100)
    return json({ error: "Percentage cannot exceed 100." });

  const config = { title, propertyKey, valueType, amount };

  // The function's input query reads the property key from this metafield so
  // it can fetch attribute(key: $propertyKey) on each cart line.
  const variablesData = { propertyKey };

  const startsAt = startDateTime
    ? new Date(startDateTime).toISOString()
    : new Date().toISOString();
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
      createdDiscountId =
        data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
    } else {
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
      createdDiscountId =
        data.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
    }

    if (!createdDiscountId) return json({ error: "Discount saved but no ID returned." });

    const nodeId = createdDiscountId.replace(
      "DiscountAutomaticApp",
      "DiscountAutomaticNode"
    );

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
            { ownerId: nodeId, namespace: NAMESPACE, key: "config", type: "json", value: configJson },
            { ownerId: nodeId, namespace: NAMESPACE, key: "variables", type: "json", value: variablesJson },
          ],
        },
      }
    );
    const metafieldsSetData = await metafieldsSetRes.json();
    const mfErrors = metafieldsSetData.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) {
      return json({ error: "Discount saved but config failed: " + mfErrors[0].message });
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message });
  }
};

// ── Page ──────────────────────────────────────────────────────────────────────

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function buildEmptyForm() {
  return {
    title: "",
    propertyKey: "",
    valueType: ["percentage"],
    amount: "",
    startDateTime: nowLocal(),
    endDateTime: "",
  };
}

function buildFormFromDiscount(d) {
  return {
    title: d.title,
    propertyKey: d.propertyKey,
    valueType: [d.valueType],
    amount: d.amount,
    startDateTime: d.startsAt,
    endDateTime: d.endsAt,
  };
}

export default function LinePropertyDiscountForm() {
  const { functionId, discount, isNew, notFound } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isEditing = !isNew && !!discount;
  const pageTitle = isEditing ? "Edit discount" : "Create discount";

  const [form, setForm] = useState(() =>
    isEditing ? buildFormFromDiscount(discount) : buildEmptyForm()
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const set = useCallback(
    (field, value) => setForm((f) => ({ ...f, [field]: value })),
    []
  );

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      shopify.toast.show(isEditing ? "Discount saved!" : "Discount created!");
      if (!isEditing) setForm(buildEmptyForm());
      setIsSubmitting(false);
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setIsSubmitting(false);
    }
  }, [fetcher.data, shopify, isEditing]);

  const handleSubmit = useCallback(() => {
    if (!form.title.trim()) {
      shopify.toast.show("Title is required.", { isError: true });
      return;
    }
    if (!form.propertyKey.trim()) {
      shopify.toast.show("Line item property key is required.", { isError: true });
      return;
    }
    const amt = parseFloat(form.amount);
    if (!(amt > 0)) {
      shopify.toast.show("Discount value must be greater than zero.", { isError: true });
      return;
    }
    if (form.valueType[0] === "percentage" && amt > 100) {
      shopify.toast.show("Percentage cannot exceed 100.", { isError: true });
      return;
    }
    setIsSubmitting(true);
    const data = new FormData();
    if (isEditing) data.append("discountId", discount.discountId);
    data.append("title", form.title);
    data.append("propertyKey", form.propertyKey.trim());
    data.append("valueType", form.valueType[0]);
    data.append("amount", form.amount);
    data.append("startDateTime", form.startDateTime);
    data.append("endDateTime", form.endDateTime);
    data.append("functionId", functionId ?? "");
    fetcher.submit(data, { method: "POST" });
  }, [form, fetcher, functionId, shopify, isEditing, discount]);

  if (notFound) {
    return (
      <Page
        backAction={{ content: "All discounts", url: "/app/discount-by-line-property" }}
        title="Discount not found"
      >
        <Banner tone="critical">
          <Text>This discount could not be found.</Text>
        </Banner>
      </Page>
    );
  }

  const isPercentage = form.valueType[0] === "percentage";

  return (
    <Page
      backAction={{ content: "All discounts", url: "/app/discount-by-line-property" }}
      title={pageTitle}
    >
      <TitleBar title={pageTitle} />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">
              The Discount by Line Item Property function is not deployed yet. Run{" "}
              <code>shopify app deploy</code>, then refresh.
            </Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Discount details
                </Text>
                <TextField
                  label="Title"
                  value={form.title}
                  onChange={(v) => set("title", v)}
                  placeholder="e.g., Free engraving line discount"
                  helpText="Internal name shown in your discounts list and at checkout"
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Matching rule
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    The discount applies to any cart line that carries a line item property
                    with this exact key (any value).
                  </Text>
                </BlockStack>
                <TextField
                  label="Line item property key"
                  value={form.propertyKey}
                  onChange={(v) => set("propertyKey", v)}
                  placeholder="e.g., _engraving"
                  helpText="The property name set on the cart line (hidden properties start with an underscore)."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Discount value
                </Text>
                <ChoiceList
                  title="Value type"
                  choices={[
                    { label: "Percentage off", value: "percentage" },
                    { label: "Fixed amount off (per item)", value: "fixedAmount" },
                  ]}
                  selected={form.valueType}
                  onChange={(v) => set("valueType", v)}
                />
                <Box maxWidth="220px">
                  <TextField
                    label={isPercentage ? "Percentage" : "Amount off each item"}
                    type="number"
                    value={form.amount}
                    onChange={(v) => set("amount", v)}
                    min={0}
                    prefix={isPercentage ? undefined : "$"}
                    suffix={isPercentage ? "%" : undefined}
                    autoComplete="off"
                    helpText={
                      isPercentage
                        ? "Use 100 for a fully free line."
                        : "Deducted from each matching item."
                    }
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Schedule
                </Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px">
                    <DateTimePicker
                      label="Start date"
                      value={form.startDateTime}
                      onChange={(v) => set("startDateTime", v)}
                    />
                  </Box>
                  <Box minWidth="300px">
                    <DateTimePicker
                      label="End date (optional)"
                      value={form.endDateTime}
                      onChange={(v) => set("endDateTime", v)}
                      helpText="Leave empty for no end date"
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
                disabled={!functionId}
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
