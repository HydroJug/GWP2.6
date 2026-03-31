import { json } from "@remix-run/node";
import { useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon,
} from "@shopify/polaris";
import {
  GiftCardIcon,
  DiscountIcon,
  ProductIcon,
  CollectionIcon,
  MobileIcon,
  StoreIcon,
  ChartHistogramGrowthIcon,
  LayoutSectionIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({});
};

const tools = [
  {
    title: "Gift with Purchase",
    description: "Configure multi-tier free gift thresholds. Customers automatically unlock gifts when their cart reaches a set value.",
    icon: GiftCardIcon,
    url: "/app/gwp-config",
    cta: "Configure GWP",
  },
  {
    title: "Product & Order Discounts",
    description: "Percentage or fixed-amount discounts with optional free shipping — all in one code.",
    icon: DiscountIcon,
    url: "/app/combined-discount",
    cta: "Manage discounts",
  },
  {
    title: "Buy X, Buy Y, Get Z Free",
    description: "Require specific products or collections in cart to unlock a free gift. Set minimum quantities for X and Y.",
    icon: GiftCardIcon,
    url: "/app/buy-xy-get-z",
    cta: "Manage discounts",
  },
  {
    title: "Bundle Builder",
    description: "Give customers a percentage or fixed amount off when they buy a bundle. Stack multiple tiers — best deal applies automatically.",
    icon: CollectionIcon,
    url: "/app/bundle-builder",
    cta: "Manage discounts",
  },
  {
    title: "Tapcart Exclusive Discounts",
    description: "App-exclusive discounts for Tapcart mobile users — amount off, buy X get Y, free shipping, and more.",
    icon: MobileIcon,
    url: "/app/tapcart",
    cta: "Manage discounts",
  },
  {
    title: "POS Only Discounts",
    description: "Create discounts that apply exclusively to Point of Sale transactions. Detects POS via a configurable cart attribute.",
    icon: StoreIcon,
    url: "/app/pos-only-discount",
    cta: "Manage discounts",
  },
  {
    title: "Buy More, Save More",
    description: "Tiered quantity price breaks for a product or collection — the more customers add to cart, the better the discount.",
    icon: ChartHistogramGrowthIcon,
    url: "/app/buy-more-save-more",
    cta: "Manage discounts",
  },
  {
    title: "Progress Bar",
    description: "Configure the cart progress bar that shows gift tier milestones. Operates independently of GWP discounts.",
    icon: LayoutSectionIcon,
    url: "/app/progress-bar",
    cta: "Configure",
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <Page>
      <TitleBar title="Discount Manager" />
      <BlockStack gap="600">
        <BlockStack gap="200">
          <Text as="h1" variant="headingXl">Discount Manager</Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Create and manage all your store discounts in one place.
          </Text>
        </BlockStack>

        <Layout>
          {tools.map((tool) => (
            <Layout.Section key={tool.url} variant="oneThird">
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="300" blockAlign="center">
                    <Box background="bg-surface-secondary" padding="200" borderRadius="200">
                      <Icon source={tool.icon} tone="base" />
                    </Box>
                    <Text as="h2" variant="headingMd">{tool.title}</Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">{tool.description}</Text>
                  <Box>
                    <Button onClick={() => navigate(tool.url)}>{tool.cta}</Button>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
          ))}
        </Layout>
      </BlockStack>
    </Page>
  );
}
