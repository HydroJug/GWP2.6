import { useState, useEffect } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  TextField,
  InlineStack,
  Banner,
  Box,
  Select,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import { getGWPSettings, saveGWPSettings } from "../lib/storage.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getGWPSettings(admin, session.shop);
  return json({
    progressBar: settings.progressBar || {
      enabled: false,
      selector: "",
      position: "below",
      modalBehavior: "auto",
      freeShipping: {
        enabled: false,
        threshold: 10000,
        method: "shipping_profile",
        discountId: null,
      },
    },
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("action") !== "saveProgressBar") {
    return json({ error: "Invalid action" }, { status: 400 });
  }

  const progressBar = JSON.parse(formData.get("progressBar"));
  const { freeShipping } = progressBar;

  try {
    // ── Manage automatic free shipping discount ──────────────────────────────
    const wantsDiscount =
      freeShipping?.enabled && freeShipping?.method === "discount";
    const existingDiscountId = freeShipping?.discountId || null;

    if (wantsDiscount) {
      const thresholdDollars = ((freeShipping.threshold || 0) / 100).toFixed(2);
      const maxCents = freeShipping.maxShippingCost;
      const maximumShippingPrice =
        maxCents != null && maxCents > 0
          ? (maxCents / 100).toFixed(2)
          : undefined;

      const baseInput = {
        title: "Free Shipping",
        minimumRequirement: {
          subtotal: { greaterThanOrEqualToSubtotal: thresholdDollars },
        },
        ...(maximumShippingPrice ? { maximumShippingPrice } : {}),
      };

      if (existingDiscountId) {
        // Update the existing discount
        const updateRes = await admin.graphql(
          `#graphql
            mutation UpdateFreeShipping($id: ID!, $input: DiscountAutomaticFreeShippingInput!) {
              discountAutomaticFreeShippingUpdate(id: $id, freeShippingAutomaticDiscount: $input) {
                automaticDiscountNode { id }
                userErrors { field message }
              }
            }`,
          { variables: { id: existingDiscountId, input: { ...baseInput, endsAt: null } } }
        );
        const updateData = await updateRes.json();
        const updateErrors =
          updateData.data?.discountAutomaticFreeShippingUpdate?.userErrors;
        if (updateErrors?.length) {
          console.error("Error updating free shipping discount:", updateErrors);
        }
      } else {
        // Create a new automatic free shipping discount
        const createRes = await admin.graphql(
          `#graphql
            mutation CreateFreeShipping($input: DiscountAutomaticFreeShippingInput!) {
              discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $input) {
                automaticDiscountNode { id }
                userErrors { field message }
              }
            }`,
          {
            variables: {
              input: {
                ...baseInput,
                startsAt: new Date().toISOString(),
              },
            },
          }
        );
        const createData = await createRes.json();
        const createErrors =
          createData.data?.discountAutomaticFreeShippingCreate?.userErrors;
        if (createErrors?.length) {
          console.error("Error creating free shipping discount:", createErrors);
        }
        const newId =
          createData.data?.discountAutomaticFreeShippingCreate
            ?.automaticDiscountNode?.id;
        if (newId) {
          progressBar.freeShipping = {
            ...progressBar.freeShipping,
            discountId: newId,
          };
        }
      }
    } else if (existingDiscountId) {
      // Deactivate the discount by setting endsAt to now
      const deactivateRes = await admin.graphql(
        `#graphql
          mutation DeactivateFreeShipping($id: ID!, $input: DiscountAutomaticFreeShippingInput!) {
            discountAutomaticFreeShippingUpdate(id: $id, freeShippingAutomaticDiscount: $input) {
              automaticDiscountNode { id }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            id: existingDiscountId,
            input: { endsAt: new Date().toISOString() },
          },
        }
      );
      const deactivateData = await deactivateRes.json();
      const deactivateErrors =
        deactivateData.data?.discountAutomaticFreeShippingUpdate?.userErrors;
      if (deactivateErrors?.length) {
        console.error(
          "Error deactivating free shipping discount:",
          deactivateErrors
        );
      }
      // Clear the stored ID since the discount is now expired
      progressBar.freeShipping = {
        ...progressBar.freeShipping,
        discountId: null,
      };
    }

    // ── Save the full updated progressBar to the metafield ──────────────────
    const existing = await getGWPSettings(admin, session.shop);
    await saveGWPSettings(admin, session.shop, {
      ...existing,
      progressBar,
    });

    return json({ success: true, message: "Progress bar settings saved!" });
  } catch (error) {
    console.error("Error saving progress bar:", error);
    return json({ success: false, error: error.message });
  }
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProgressBarConfig() {
  const { progressBar: initialProgressBar } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [config, setConfig] = useState({
    enabled: initialProgressBar.enabled ?? false,
    selector: initialProgressBar.selector ?? "",
    position: initialProgressBar.position ?? "below",
    modalBehavior: initialProgressBar.modalBehavior ?? "auto",
    freeShipping: {
      enabled: initialProgressBar.freeShipping?.enabled ?? false,
      threshold: initialProgressBar.freeShipping?.threshold ?? 10000,
      method: initialProgressBar.freeShipping?.method ?? "shipping_profile",
      discountId: initialProgressBar.freeShipping?.discountId ?? null,
      maxShippingCost: initialProgressBar.freeShipping?.maxShippingCost ?? null,
    },
  });

  const isLoading = ["loading", "submitting"].includes(fetcher.state);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Error: ${fetcher.data.error}`, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    fetcher.submit(
      { action: "saveProgressBar", progressBar: JSON.stringify(config) },
      { method: "POST" }
    );
  };

  const setFreeShipping = (updates) =>
    setConfig((prev) => ({
      ...prev,
      freeShipping: { ...prev.freeShipping, ...updates },
    }));

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title="Progress Bar"
      subtitle="Configure the cart progress bar that shows gift tier milestones."
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: isLoading,
      }}
    >
      <TitleBar title="Progress Bar" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* ── Progress bar display settings ── */}
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">
                  Progress Bar Configuration
                </Text>

                <Banner tone="info">
                  <p>
                    The progress bar appears on your storefront and shows
                    customers how close they are to unlocking gift tiers. It
                    operates independently of any active GWP discount — tiers
                    appear when the &ldquo;Show on progress bar&rdquo; option is
                    enabled on each GWP tier.
                  </p>
                </Banner>

                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <TextField
                      label="CSS Selector"
                      value={config.selector}
                      onChange={(value) =>
                        setConfig((prev) => ({ ...prev, selector: value }))
                      }
                      placeholder="e.g., .cart__items, #cart, .product-form"
                      helpText="Target element where progress bar should appear"
                    />
                  </Box>
                  <Box minWidth="150px">
                    <Select
                      label="Position"
                      options={[
                        { label: "Above", value: "above" },
                        { label: "Below", value: "below" },
                      ]}
                      value={config.position}
                      onChange={(value) =>
                        setConfig((prev) => ({ ...prev, position: value }))
                      }
                    />
                  </Box>
                  <Box minWidth="200px">
                    <Select
                      label="Modal Behavior"
                      options={[
                        {
                          label: "Auto-popup when threshold met",
                          value: "auto",
                        },
                        {
                          label: "Only on progress bar click",
                          value: "click",
                        },
                      ]}
                      value={config.modalBehavior}
                      onChange={(value) =>
                        setConfig((prev) => ({
                          ...prev,
                          modalBehavior: value,
                        }))
                      }
                      helpText="When should the gift modal appear?"
                    />
                  </Box>
                  <Box paddingBlockStart="600">
                    <Button
                      variant={config.enabled ? "primary" : "secondary"}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          enabled: !prev.enabled,
                        }))
                      }
                    >
                      {config.enabled ? "Enabled" : "Disabled"}
                    </Button>
                  </Box>
                </InlineStack>

                {config.enabled && config.selector && (
                  <Banner tone="success">
                    <p>
                      Progress bar will appear{" "}
                      <strong>{config.position}</strong> the element:{" "}
                      <code>{config.selector}</code>
                    </p>
                  </Banner>
                )}

                {config.enabled && !config.selector && (
                  <Banner tone="warning">
                    <p>
                      Please enter a CSS selector to specify where the progress
                      bar should appear.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            {/* ── Free shipping settings ── */}
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">
                  Free Shipping Indicator
                </Text>

                <InlineStack gap="400" wrap blockAlign="end">
                  <Box minWidth="200px">
                    <TextField
                      label="Free Shipping Threshold"
                      type="number"
                      value={String(
                        config.freeShipping?.threshold / 100 || 100
                      )}
                      onChange={(value) =>
                        setFreeShipping({
                          threshold: Math.round(
                            parseFloat(value || 0) * 100
                          ),
                        })
                      }
                      prefix="$"
                      helpText="Cart total needed for free shipping"
                    />
                  </Box>
                  <Box minWidth="260px">
                    <Select
                      label="Free Shipping Method"
                      options={[
                        {
                          label: "Use shipping profile (manual)",
                          value: "shipping_profile",
                        },
                        {
                          label: "Create automatic free shipping discount",
                          value: "discount",
                        },
                      ]}
                      value={config.freeShipping?.method ?? "shipping_profile"}
                      onChange={(value) => setFreeShipping({ method: value })}
                      helpText={
                        config.freeShipping?.method === "discount"
                          ? "Saving will create or update a Shopify automatic discount for free shipping."
                          : "Configure free shipping in your Shopify shipping profiles manually."
                      }
                    />
                  </Box>
                  {config.freeShipping?.method === "discount" && (
                    <Box minWidth="200px">
                      <TextField
                        label="Maximum Shipping Cost"
                        type="number"
                        value={
                          config.freeShipping?.maxShippingCost != null &&
                          config.freeShipping.maxShippingCost > 0
                            ? String(config.freeShipping.maxShippingCost / 100)
                            : ""
                        }
                        onChange={(value) =>
                          setFreeShipping({
                            maxShippingCost: value
                              ? Math.round(parseFloat(value) * 100)
                              : null,
                          })
                        }
                        prefix="$"
                        placeholder="No limit"
                        helpText="Only apply to shipping rates at or below this amount. Leave blank to apply to all rates."
                      />
                    </Box>
                  )}
                  <Box paddingBlockStart="200">
                    <Button
                      variant={
                        config.freeShipping?.enabled ? "primary" : "secondary"
                      }
                      onClick={() =>
                        setFreeShipping({
                          enabled: !config.freeShipping?.enabled,
                        })
                      }
                    >
                      {config.freeShipping?.enabled ? "Enabled" : "Disabled"}
                    </Button>
                  </Box>
                </InlineStack>

                {config.freeShipping?.enabled &&
                  config.freeShipping?.method === "discount" && (
                    <Banner tone="info">
                      <p>
                        An automatic free shipping discount will be created (or
                        updated) in Shopify when you save — customers will
                        receive free shipping on all destinations once their
                        cart reaches{" "}
                        <strong>
                          ${(config.freeShipping.threshold / 100).toFixed(2)}
                        </strong>
                        .
                        {config.freeShipping.discountId && (
                          <>
                            {" "}
                            An existing discount is already linked to this
                            progress bar.
                          </>
                        )}
                      </p>
                    </Banner>
                  )}

                {config.freeShipping?.enabled &&
                  config.freeShipping?.method === "shipping_profile" && (
                    <Banner tone="info">
                      <p>
                        The progress bar will show a free shipping milestone at{" "}
                        <strong>
                          ${(config.freeShipping.threshold / 100).toFixed(2)}
                        </strong>
                        . Make sure your Shopify shipping profile has a
                        corresponding free shipping rate configured.
                      </p>
                    </Banner>
                  )}

                {!config.freeShipping?.enabled && (
                  <Banner tone="default">
                    <p>
                      Free shipping indicator is disabled. Enable it to show a
                      free shipping milestone on the progress bar.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

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
