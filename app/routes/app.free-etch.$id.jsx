import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState, useEffect } from "react";
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
  Divider,
  Badge,
  ChoiceList,
} from "@shopify/polaris";
import DateTimePicker from "../components/DateTimePicker";
import DiscountStatusToggle from "../components/DiscountStatusToggle";
import {
  STACKING_API_VERSION,
  freeEtchStackingInput,
  getStackableDiscount,
  listStackableDiscounts,
  setStacksWithFreeEtch,
} from "../lib/discountStacking.server";

function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const isNew = params.id === "new";

  const fnRes = await admin.graphql(
    `query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`
  );
  const fnData = await fnRes.json();
  const allMatches = (fnData.data?.shopifyFunctions?.nodes ?? []).filter(
    (f) => f.title === "Free Etch Discount" && f.apiType === "discount"
  );
  const functionId = allMatches[allMatches.length - 1]?.id ?? null;

  let stackable = [];
  let stackableTruncated = false;
  let stackableError = null;
  try {
    const result = await listStackableDiscounts(admin, functionId);
    stackable = result.discounts.map(({ id, title, status, stacks }) => ({ id, title, status, stacks }));
    stackableTruncated = result.truncated;
  } catch (err) {
    stackableError = err.message;
  }

  if (isNew) {
    return json({ functionId, discount: null, isNew: true, stackable, stackableTruncated, stackableError });
  }

  const rawId = params.id;
  let automaticGid, codeGid;

  if (rawId.startsWith("gid://shopify/DiscountAutomaticNode/")) {
    automaticGid = rawId;
    codeGid = null;
  } else if (rawId.startsWith("gid://shopify/DiscountCodeNode/")) {
    automaticGid = null;
    codeGid = rawId;
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
          metafield(namespace: "free_etch", key: "config") { value }
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
      d = node.automaticDiscount;
      config = node.metafield?.value ? JSON.parse(node.metafield.value) : {};
      resolvedGid = automaticGid;
    }
  }

  if (!d && codeGid) {
    const res = await admin.graphql(
      `query GetDiscount($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          metafield(namespace: "free_etch", key: "config") { value }
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

  if (!d) {
    return json({ functionId, discount: null, isNew: false, notFound: true });
  }

  return json({
    functionId,
    isNew: false,
    stackable,
    stackableTruncated,
    stackableError,
    discount: {
      nodeId: resolvedGid,
      discountId: d.discountId,
      discountType: resolvedGid?.includes("DiscountAutomaticNode") ? "automatic" : "code",
      title: d.title ?? "",
      code: d.codes?.edges?.[0]?.node?.code ?? "",
      status: d.status,
      startsAt: d.startsAt ? d.startsAt.slice(0, 16) : "",
      endsAt: d.endsAt ? d.endsAt.slice(0, 16) : "",
      usageLimit: d.usageLimit?.toString() ?? "",
      appliesOncePerCustomer: d.appliesOncePerCustomer ?? false,
      orderMinimum: config.orderMinimum ?? 0,
    },
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const isNew = params.id === "new";

  const functionId = formData.get("functionId");
  const title = formData.get("title")?.trim();
  const discountType = formData.get("discountType") ?? "automatic";
  const code = formData.get("code")?.trim();
  const orderMinimum = Math.round(parseFloat(formData.get("orderMinimum") || "0") * 100);
  const startDateTime = formData.get("startDateTime");
  const endDateTime = formData.get("endDateTime");
  const usageLimit = formData.get("usageLimit");
  const appliesOncePerCustomer = formData.get("appliesOncePerCustomer") === "true";
  const discountId = formData.get("discountId");
  // { [discountNodeId]: shouldStack } for only the discounts the user toggled.
  const stackChanges = JSON.parse(formData.get("stackChanges") || "{}");

  if (!functionId) {
    return json({ error: "Free Etch Discount function is not deployed yet." });
  }
  if (!title) {
    return json({ error: "Title is required." });
  }

  const config = { title, orderMinimum };
  const configJson = JSON.stringify(config);

  const startsAt = startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString();
  const endsAt = endDateTime ? new Date(endDateTime).toISOString() : null;

  const discountInput = {
    title,
    functionId,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    discountClasses: ["PRODUCT"],
    ...freeEtchStackingInput(),
  };
  const gqlOptions = (variables) => ({ variables, apiVersion: STACKING_API_VERSION });

  try {
    let createdDiscountId;

    if (!isNew && discountId) {
      if (discountType === "automatic") {
        const res = await admin.graphql(
          `mutation($id: ID!, $input: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          gqlOptions({ id: discountId, input: discountInput })
        );
        const data = await res.json();
        const errors = data.data?.discountAutomaticAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
      } else {
        const res = await admin.graphql(
          `mutation($id: ID!, $input: DiscountCodeAppInput!) {
            discountCodeAppUpdate(id: $id, codeAppDiscount: $input) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          gqlOptions({
            id: discountId,
            input: {
              ...discountInput,
              usageLimit: usageLimit ? parseInt(usageLimit, 10) : null,
              appliesOncePerCustomer,
            },
          })
        );
        const data = await res.json();
        const errors = data.data?.discountCodeAppUpdate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        createdDiscountId = data.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId;
      }
    } else {
      if (discountType === "automatic") {
        const res = await admin.graphql(
          `mutation($input: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $input) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          gqlOptions({ input: discountInput })
        );
        const data = await res.json();
        const errors = data.data?.discountAutomaticAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        createdDiscountId = data.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
      } else {
        const res = await admin.graphql(
          `mutation($input: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $input) {
              codeAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          gqlOptions({ input: { ...discountInput, code } })
        );
        const data = await res.json();
        const errors = data.data?.discountCodeAppCreate?.userErrors ?? [];
        if (errors.length) return json({ error: errors[0].message });
        createdDiscountId = data.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
      }
    }

    if (!createdDiscountId) return json({ error: "Discount saved but no ID returned." });

    const nodeId = createdDiscountId
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
            { ownerId: nodeId, namespace: "free_etch", key: "config", type: "json", value: configJson },
          ],
        },
      }
    );
    const mfData = await mfRes.json();
    const mfErrors = mfData.data?.metafieldsSet?.userErrors ?? [];
    if (mfErrors.length) {
      return json({ error: "Discount saved but config failed: " + mfErrors[0].message });
    }

    const stackErrors = [];
    for (const [id, wanted] of Object.entries(stackChanges)) {
      try {
        const other = await getStackableDiscount(admin, id, functionId);
        if (!other || other.stacks === Boolean(wanted)) continue;
        const error = await setStacksWithFreeEtch(admin, other, Boolean(wanted));
        if (error) stackErrors.push(error);
      } catch (err) {
        stackErrors.push(`${id}: ${err.message}`);
      }
    }
    if (stackErrors.length) {
      return json({ error: `Discount saved, but stacking couldn't be updated for ${stackErrors.join("; ")}` });
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message });
  }
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function FreeEtchForm() {
  const {
    functionId,
    discount,
    isNew,
    notFound,
    stackable = [],
    stackableTruncated,
    stackableError,
  } = useLoaderData();
  const fetcher = useFetcher();
  const searchFetcher = useFetcher();
  const shopify = useAppBridge();

  const [title, setTitle] = useState(discount?.title ?? "");
  const [discountType, setDiscountType] = useState(discount?.discountType ?? "automatic");
  const [code, setCode] = useState(discount?.code ?? "");
  const [orderMinimum, setOrderMinimum] = useState(
    discount?.orderMinimum ? String(discount.orderMinimum / 100) : ""
  );
  const [startDateTime, setStartDateTime] = useState(discount?.startsAt ?? nowLocal());
  const [endDateTime, setEndDateTime] = useState(discount?.endsAt ?? "");
  const [usageLimit, setUsageLimit] = useState(discount?.usageLimit ?? "");
  const [appliesOncePerCustomer, setAppliesOncePerCustomer] = useState(
    discount?.appliesOncePerCustomer ?? false
  );
  // Discounts shown in the stacking list: the loader's, plus code discounts found
  // by search. Each keeps the stacking state it had when first shown, so saving
  // only touches the ones the user toggled.
  const [knownStackable, setKnownStackable] = useState(stackable);
  const [stackWithIds, setStackWithIds] = useState(
    stackable.filter((d) => d.stacks).map((d) => d.id)
  );
  const [stackSearch, setStackSearch] = useState("");

  useEffect(() => {
    const found = searchFetcher.data?.discounts;
    if (!found?.length) return;
    const knownIds = new Set(knownStackable.map((d) => d.id));
    const added = found.filter((d) => !knownIds.has(d.id));
    if (!added.length) return;
    setKnownStackable([...knownStackable, ...added]);
    setStackWithIds((ids) => [...new Set([...ids, ...added.filter((d) => d.stacks).map((d) => d.id)])]);
  }, [searchFetcher.data, knownStackable]);

  const runStackSearch = () => {
    if (!stackSearch.trim()) return;
    const params = new URLSearchParams({ q: stackSearch, functionId: functionId ?? "" });
    searchFetcher.load(`/api/stackable-discounts?${params}`);
  };

  const isLoading = ["loading", "submitting"].includes(fetcher.state);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Discount saved!");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    const stackChanges = {};
    for (const d of knownStackable) {
      const wanted = stackWithIds.includes(d.id);
      if (wanted !== d.stacks) stackChanges[d.id] = wanted;
    }
    fetcher.submit(
      {
        functionId,
        title,
        discountType,
        code,
        orderMinimum,
        startDateTime,
        endDateTime,
        usageLimit,
        appliesOncePerCustomer: String(appliesOncePerCustomer),
        discountId: discount?.discountId ?? "",
        stackChanges: JSON.stringify(stackChanges),
      },
      { method: "POST" }
    );
  };

  if (notFound) {
    return (
      <Page backAction={{ content: "Free Etch Discount", url: "/app/free-etch" }} title="Not Found">
        <Banner tone="critical">
          <p>This discount could not be found.</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      backAction={{ content: "Free Etch Discount", url: "/app/free-etch" }}
      title={isNew ? "Create Free Etch Discount" : "Edit Free Etch Discount"}
      primaryAction={{ content: "Save", onAction: handleSave, loading: isLoading }}
    >
      <TitleBar title={isNew ? "Create Free Etch Discount" : "Edit Free Etch Discount"} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {!isNew && discount?.status && (
              <Card>
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" fontWeight="medium">Discount status</Text>
                    <Badge tone={discount.status === "ACTIVE" ? "success" : discount.status === "SCHEDULED" ? "info" : "critical"}>
                      {discount.status.charAt(0) + discount.status.slice(1).toLowerCase()}
                    </Badge>
                  </InlineStack>
                  <DiscountStatusToggle discountId={discount.nodeId} discountType={discount.discountType} status={discount.status} size="medium" />
                </InlineStack>
              </Card>
            )}

            {fetcher.data?.error && (
              <Banner tone="critical">
                <p>{fetcher.data.error}</p>
              </Banner>
            )}

            {/* ── Details ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Discount details</Text>

                <TextField
                  label="Title"
                  value={title}
                  onChange={setTitle}
                  placeholder="e.g., Free Etch Weekend"
                  helpText="Shown in the discount list and on the order."
                  autoComplete="off"
                />

                <ChoiceList
                  title="Discount type"
                  choices={[
                    { label: "Automatic — applies without a code", value: "automatic" },
                    { label: "Code — customer must enter a code", value: "code" },
                  ]}
                  selected={[discountType]}
                  onChange={([val]) => setDiscountType(val)}
                />

                {discountType === "code" && (
                  <TextField
                    label="Discount code"
                    value={code}
                    onChange={setCode}
                    placeholder="e.g., FREEETCH"
                    autoComplete="off"
                  />
                )}
              </BlockStack>
            </Card>

            {/* ── Minimum requirement ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Minimum order value</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  The etch surcharge is waived on all cart lines that have an{" "}
                  <code>etchInfo</code> attribute once the cart subtotal reaches
                  this amount.
                </Text>
                <Box maxWidth="220px">
                  <TextField
                    label="Order minimum"
                    type="number"
                    value={orderMinimum}
                    onChange={setOrderMinimum}
                    prefix="$"
                    placeholder="0.00"
                    helpText="Subtotal required before the free etch discount applies."
                    autoComplete="off"
                  />
                </Box>

                {orderMinimum && parseFloat(orderMinimum) > 0 && (
                  <Banner tone="info">
                    <p>
                      Etch surcharges ($9.99 standard / $12.99 custom upload) will
                      be removed from all etched items once the cart reaches{" "}
                      <strong>${parseFloat(orderMinimum).toFixed(2)}</strong>.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            {/* ── Same-item stacking ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Stack with other product discounts</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Shopify applies only one product discount per item. Checked discounts
                  also apply to etched items, together with the free etch. Requires
                  Shopify Plus.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  This list is shared by every free etch discount, not just this one.
                  Checking a discount also turns on its &ldquo;combines with product
                  discounts&rdquo; setting; unchecking it turns that back off if this
                  list turned it on.
                </Text>
                {stackableError ? (
                  <Banner tone="warning">
                    <p>Couldn&apos;t load product discounts: {stackableError}</p>
                  </Banner>
                ) : (
                  <BlockStack gap="300">
                    {stackableTruncated && (
                      <Banner tone="info">
                        <p>Only the first discounts are shown. Search to find others.</p>
                      </Banner>
                    )}
                    {knownStackable.length === 0 ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No automatic product discounts. Search to add code discounts.
                      </Text>
                    ) : (
                      <ChoiceList
                        title="Product discounts"
                        titleHidden
                        allowMultiple
                        choices={knownStackable.map((d) => ({
                          label: d.status === "ACTIVE" ? d.title : `${d.title} (${d.status.toLowerCase()})`,
                          value: d.id,
                        }))}
                        selected={stackWithIds}
                        onChange={setStackWithIds}
                      />
                    )}
                    <TextField
                      label="Find code discounts"
                      value={stackSearch}
                      onChange={setStackSearch}
                      placeholder="Discount name"
                      autoComplete="off"
                      connectedRight={
                        <Button onClick={runStackSearch} loading={searchFetcher.state === "loading"}>
                          Search
                        </Button>
                      }
                    />
                    {searchFetcher.data?.error && (
                      <Banner tone="warning">
                        <p>Search failed: {searchFetcher.data.error}</p>
                      </Banner>
                    )}
                    {searchFetcher.state === "idle" && searchFetcher.data?.discounts?.length === 0 && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No matching code product discounts.
                      </Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* ── Active dates ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Active dates</Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="300px">
                    <DateTimePicker
                      label="Start date and time"
                      value={startDateTime}
                      onChange={setStartDateTime}
                    />
                  </Box>
                  <Box minWidth="300px">
                    <DateTimePicker
                      label="End date and time (optional)"
                      value={endDateTime}
                      onChange={setEndDateTime}
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Usage limits (code only) ── */}
            {discountType === "code" && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Usage limits</Text>
                  <TextField
                    label="Total usage limit (optional)"
                    type="number"
                    value={usageLimit}
                    onChange={setUsageLimit}
                    placeholder="No limit"
                    helpText="Maximum number of times this code can be used in total."
                    autoComplete="off"
                  />
                  <ChoiceList
                    title=""
                    choices={[
                      { label: "Limit to one use per customer", value: "once" },
                    ]}
                    selected={appliesOncePerCustomer ? ["once"] : []}
                    onChange={(selected) => setAppliesOncePerCustomer(selected.includes("once"))}
                    allowMultiple
                  />
                </BlockStack>
              </Card>
            )}

            {/* ── Summary ── */}
            {!isNew && discount?.status && (
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
              <Button variant="primary" onClick={handleSave} loading={isLoading}>
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
