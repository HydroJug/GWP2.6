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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [fnRes, listRes] = await Promise.all([
    admin.graphql(`query { shopifyFunctions(first: 25) { nodes { id title apiType } } }`),
    admin.graphql(DISCOUNT_LIST_QUERY),
  ]);

  const fnData = await fnRes.json();
  const allFns = (fnData.data?.shopifyFunctions?.nodes ?? [])
    .filter((f) => f.apiType === "discount" && f.title === "Combined Discount");
  const functionId = allFns.length ? allFns[allFns.length - 1].id : null;
  const allFunctionIds = allFns.map((f) => f.id);

  const listData = await listRes.json();
  const discounts = filterDiscountsByFunction(listData.data, allFunctionIds);

  return json({ functionId, discounts });
};

export default function CombinedDiscountList() {
  const { functionId, discounts } = useLoaderData();
  const navigate = useNavigate();
  const goToCreate = useCallback(() => navigate("/app/combined-discount/new"), [navigate]);

  const rowMarkup = discounts.map((d, i) => (
    <IndexTable.Row
      id={d.id}
      key={d.id}
      position={i}
      onClick={() => navigate(`/app/combined-discount/${encodeURIComponent(d.id)}`)}
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
      <IndexTable.Cell>{formatDate(d.endsAt)}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title="Product & Order Discounts"
      subtitle="Percentage or fixed-amount discounts with optional free shipping."
      primaryAction={{
        content: "Create discount",
        onAction: goToCreate,
      }}
    >
      <TitleBar title="Product & Order Discounts" />

      {!functionId && (
        <Box paddingBlockEnd="400">
          <Banner tone="warning">
            <Text variant="bodyMd">
              The Combined Discount function is not deployed yet. Run{" "}
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
                heading="No discounts yet"
                action={{ content: "Create discount", onAction: goToCreate }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Create a percentage or fixed-amount discount, optionally bundled with free shipping.</p>
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
