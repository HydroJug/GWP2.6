import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  allowedGorgiasTags,
  checkGorgiasConnection,
  gorgiasSecretForShop,
} from "../lib/gorgias.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const appUrl = (process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  return json({
    shop: session.shop,
    endpointUrl: `${appUrl}/api/gorgias/customer-tags`,
    secret: gorgiasSecretForShop(session.shop),
    allowedTags: allowedGorgiasTags(),
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return json(await checkGorgiasConnection(session.shop));
};

export default function GorgiasSetup() {
  const { shop, endpointUrl, secret, allowedTags } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const [tag, setTag] = useState(allowedTags[0] ?? "");

  const authorization = secret ? `Bearer ${secret}` : "";
  const body = JSON.stringify(
    {
      shop,
      customerId: "{{ticket.customer.integrations.shopify.customer.id}}",
      tags: [tag],
    },
    null,
    2
  );

  const copy = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      shopify.toast.show(`Copied ${label}`);
    } catch {
      shopify.toast.show(`Could not copy ${label}.`, { isError: true });
    }
  };

  const checking = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <Page>
      <TitleBar title="Gorgias" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!secret && (
              <Banner tone="critical" title="Gorgias hook isn't configured">
                <p>
                  Set <code>GORGIAS_HOOK_SECRET</code> in the app&apos;s environment to a long
                  random value and redeploy. This page will then show this store&apos;s setup.
                </p>
              </Banner>
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Connection</Text>
                <Text as="p" tone="subdued">
                  Checks that the endpoint can get a Shopify token for {shop} and that the
                  write_customers permission is approved.
                </Text>
                {result && (
                  <Banner tone={result.ok ? "success" : "warning"}>
                    <p>{result.message}</p>
                  </Banner>
                )}
                <InlineStack>
                  <Button
                    loading={checking}
                    onClick={() => fetcher.submit({}, { method: "POST" })}
                  >
                    Check connection
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {secret && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Macro HTTP hook</Text>
                  <Text as="p" tone="subdued">
                    In Gorgias, open the macro, choose Add action → HTTP hook, and fill it in with
                    these values. The macro adds the tag when it&apos;s sent.
                  </Text>

                  <SetupField label="Method" value="POST" />
                  <SetupField label="URL" value={endpointUrl} onCopy={() => copy("URL", endpointUrl)} />
                  <SetupField
                    label="Header: Authorization"
                    value={authorization}
                    onCopy={() => copy("Authorization header", authorization)}
                    helpText="Unique to this store. Treat it like a password."
                  />

                  {allowedTags.length > 1 && (
                    <Select
                      label="Tag to add"
                      options={allowedTags.map((t) => ({ label: t, value: t }))}
                      value={tag}
                      onChange={setTag}
                    />
                  )}
                  <SetupField
                    label="Body (application/json)"
                    value={body}
                    multiline
                    onCopy={() => copy("body", body)}
                  />
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">How it works</Text>
              <List>
                <List.Item>A rep sends the macro on a ticket.</List.Item>
                <List.Item>
                  Gorgias calls this app, which adds the tag to the ticket customer&apos;s Shopify
                  profile without touching their other tags.
                </List.Item>
                <List.Item>
                  A discount limited to customers with that tag then applies when they log in
                  and check out.
                </List.Item>
              </List>
              <Text as="p" tone="subdued">
                Allowed tags: {allowedTags.join(", ")}. Change them with the
                GORGIAS_ALLOWED_TAGS environment variable.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function SetupField({ label, value, onCopy, helpText, multiline = false }) {
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" variant="headingSm">{label}</Text>
        {onCopy && <Button variant="plain" onClick={onCopy}>Copy</Button>}
      </InlineStack>
      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
        <Text as="p" fontFamily="mono" breakWord>
          {multiline ? <span style={{ whiteSpace: "pre-wrap" }}>{value}</span> : value}
        </Text>
      </Box>
      {helpText && <Text as="p" variant="bodySm" tone="subdued">{helpText}</Text>}
    </BlockStack>
  );
}
