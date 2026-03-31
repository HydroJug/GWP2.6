import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { useCallback } from "react";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  EmptyState,
  Box,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  DISCOUNT_LIST_QUERY,
  filterDiscountsByFunction,
  statusBadgeTone,
  formatDate,
} from "../utils/discountList";
import { setGWPIsActive } from "../lib/storage.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [fnRes, listRes] = await Promise.all([
    admin.graphql(`query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`),
    admin.graphql(DISCOUNT_LIST_QUERY),
  ]);

  const fnData = await fnRes.json();
  const gwpFns = (fnData.data?.shopifyFunctions?.nodes ?? []).filter(
    (f) =>
      f.apiType === "discount" &&
      (f.title?.toLowerCase().includes("gwp") ||
        f.title?.toLowerCase().includes("gift"))
  );
  const functionId = gwpFns.length ? gwpFns[gwpFns.length - 1].id : null;
  const allFunctionIds = gwpFns.map((f) => f.id);

  const listData = await listRes.json();
  const discounts = filterDiscountsByFunction(listData.data, allFunctionIds);

  // Sync isActive in metafield if no active discounts remain
  const hasActiveDiscounts = discounts.some((d) => d.status === "ACTIVE");
  if (!hasActiveDiscounts) {
    try {
      await setGWPIsActive(admin, false);
    } catch (e) {
      console.error("Failed to sync GWP isActive:", e);
    }
  }

  return json({ functionId, discounts });
};

export default function GWPConfigIndex() {
  const { functionId, discounts } = useLoaderData();
  const navigate = useNavigate();
  const goToCreate = useCallback(() => navigate("/app/gwp-config/new"), [navigate]);

  const rowMarkup = discounts.map((d, i) => (
    <IndexTable.Row
      id={d.id}
      key={d.id}
      position={i}
      onClick={() => navigate(`/app/gwp-config/${encodeURIComponent(d.id)}`)}
    >
      <IndexTable.Cell>
        <Text fontWeight="semibold" as="span">{d.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusBadgeTone(d.status)}>
          {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatDate(d.startsAt)}</IndexTable.Cell>
      <IndexTable.Cell>{formatDate(d.endsAt)}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title="Gift with Purchase"
      subtitle="Multi-tier free gift thresholds based on cart value."
      primaryAction={{
        content: "Create GWP discount",
        onAction: goToCreate,
      }}
    >
      <TitleBar title="Gift with Purchase" />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">
              The GWP discount function is not deployed yet. Run{" "}
              <code>shopify app deploy</code>, then refresh.
            </Text>
          </Banner>
        </Box>
      )}

      <Layout>
        <Layout.Section>
          <Card padding="0">
            {discounts.length === 0 ? (
              <EmptyState
                heading="No GWP discounts yet"
                action={{ content: "Create GWP discount", onAction: goToCreate }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Configure gift tiers to automatically unlock free gifts when customers reach a cart value threshold.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "discount", plural: "discounts" }}
                itemCount={discounts.length}
                selectable={false}
                headings={[
                  { title: "Title" },
                  { title: "Status" },
                  { title: "Starts" },
                  { title: "Ends" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
