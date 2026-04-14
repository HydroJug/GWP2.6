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
import { useDiscountAnalytics, AnalyticsCells, analyticsHeadings } from "../components/DiscountAnalytics";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [fnRes, listRes] = await Promise.all([
    admin.graphql(`query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`),
    admin.graphql(DISCOUNT_LIST_QUERY),
  ]);

  const fnData = await fnRes.json();
  const allFns = (fnData.data?.shopifyFunctions?.nodes ?? [])
    .filter((f) => f.title === "Bundle Builder" && f.apiType === "discount");
  const functionId = allFns.length ? allFns[allFns.length - 1].id : null;
  const allFunctionIds = allFns.map((f) => f.id);

  const listData = await listRes.json();
  const discounts = filterDiscountsByFunction(listData.data, allFunctionIds);

  return json({ functionId, discounts });
};

export default function BundleBuilderList() {
  const { functionId, discounts } = useLoaderData();
  const navigate = useNavigate();
  const goToCreate = useCallback(() => navigate("/app/bundle-builder/new"), [navigate]);
  const analytics = useDiscountAnalytics(discounts);

  const rowMarkup = discounts.map((d, i) => (
    <IndexTable.Row
      id={d.id}
      key={d.id}
      position={i}
      onClick={() => navigate(`/app/bundle-builder/${encodeURIComponent(d.id)}`)}
    >
      <IndexTable.Cell>
        <Text fontWeight="semibold" as="span">{d.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={d.discountType === "automatic" ? "info" : "default"}>
          {d.discountType === "automatic" ? "Automatic" : "Code"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">{d.code ?? "—"}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusBadgeTone(d.status)}>
          {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatDate(d.startsAt)}</IndexTable.Cell>
      <AnalyticsCells data={analytics[d.id]} />
    </IndexTable.Row>
  ));

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title="Bundle Builder"
      subtitle="Give customers a discount when they buy a bundle of products."
      primaryAction={{
        content: "Create discount",
        onAction: goToCreate,
      }}
    >
      <TitleBar title="Bundle Builder" />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">
              The Bundle Builder function is not deployed yet. Run{" "}
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
                heading="No bundle discounts yet"
                action={{ content: "Create discount", onAction: goToCreate }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Create bundle discounts that reward customers for buying product combinations.
                  Stack multiple tiers — the best qualifying bundle applies automatically.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "discount", plural: "discounts" }}
                itemCount={discounts.length}
                selectable={false}
                headings={[
                  { title: "Title" },
                  { title: "Type" },
                  { title: "Code" },
                  { title: "Status" },
                  { title: "Starts" },
                  ...analyticsHeadings,
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
