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
import { statusBadgeTone, formatDate } from "../utils/discountList";
import { useDiscountAnalytics, AnalyticsCells, analyticsHeadings } from "../components/DiscountAnalytics";
import DiscountStatusToggle from "../components/DiscountStatusToggle";

const BULK_LIST_QUERY = `
  query BulkDiscountList {
    discountNodes(first: 250, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        metafield(namespace: "bulk_discount", key: "config") { value }
        discount {
          ... on DiscountCodeApp {
            title
            status
            startsAt
            endsAt
            codesCount { count }
            appDiscountType { functionId }
          }
        }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [fnRes, listRes] = await Promise.all([
    admin.graphql(`query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`),
    admin.graphql(BULK_LIST_QUERY),
  ]);

  const fnData = await fnRes.json();
  const allFns = (fnData.data?.shopifyFunctions?.nodes ?? [])
    .filter((f) => f.apiType === "discount" && f.title === "Bulk Discount Generator");
  const functionId = allFns.length ? allFns[allFns.length - 1].id : null;
  const idSet = new Set(allFns.map((f) => f.id));

  const nodes = (await listRes.json()).data?.discountNodes?.nodes ?? [];
  const discounts = nodes
    .filter((n) => n.discount?.appDiscountType?.functionId && idSet.has(n.discount.appDiscountType.functionId))
    .map((n) => {
      const d = n.discount;
      let prefix = "";
      try {
        prefix = n.metafield?.value ? JSON.parse(n.metafield.value).prefix ?? "" : "";
      } catch {
        prefix = "";
      }
      return {
        id: n.id,
        title: d.title,
        status: d.status,
        startsAt: d.startsAt,
        prefix,
        codesCount: d.codesCount?.count ?? 0,
      };
    })
    .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));

  return json({ functionId, discounts });
};

export default function BulkDiscountGeneratorList() {
  const { functionId, discounts } = useLoaderData();
  const navigate = useNavigate();
  const goToCreate = useCallback(() => navigate("/app/bulk-discount-generator/new"), [navigate]);
  const analytics = useDiscountAnalytics(discounts);

  const rowMarkup = discounts.map((d, i) => (
    <IndexTable.Row
      id={d.id}
      key={d.id}
      position={i}
      onClick={() => navigate(`/app/bulk-discount-generator/${encodeURIComponent(d.id)}`)}
    >
      <IndexTable.Cell>
        <Text fontWeight="semibold" as="span">{d.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">{d.prefix || "—"}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span">{d.codesCount}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusBadgeTone(d.status)}>
          {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatDate(d.startsAt)}</IndexTable.Cell>
      <AnalyticsCells data={analytics[d.id]} />
      <IndexTable.Cell>
        <DiscountStatusToggle
          discountId={d.id}
          discountType="code"
          status={d.status}
          inRow
        />
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title="Bulk Discount Generator"
      subtitle="Create one price rule and generate many unique codes that share those terms."
      primaryAction={{
        content: "Create price rule",
        onAction: goToCreate,
      }}
    >
      <TitleBar title="Bulk Discount Generator" />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">
              The Bulk Discount Generator function is not deployed yet. Run{" "}
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
                heading="No bulk price rules yet"
                action={{ content: "Create price rule", onAction: goToCreate }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Generate unique discount codes that all share the same product, order, and shipping terms.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "price rule", plural: "price rules" }}
                itemCount={discounts.length}
                selectable={false}
                headings={[
                  { title: "Title" },
                  { title: "Prefix" },
                  { title: "Codes" },
                  { title: "Status" },
                  { title: "Starts" },
                  ...analyticsHeadings,
                  { title: "Actions" },
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
