import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_MESSAGE,
  disableBlock,
  enableBlock,
  getBlockState,
  getValidationStatus,
  listLiveAutomaticDiscounts,
  resumeIfNeeded,
  setExempt,
  updateMessage,
} from "../lib/discountBlock.server";
import { syncGWPActiveState } from "../lib/storage.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  // If the last run didn't finish (a pause failed, a webhook errored, a
  // request timed out), retry it now. Errors show on the page.
  let state;
  try {
    state = await resumeIfNeeded(admin);
  } catch (err) {
    console.error("[discount-block] resume failed:", err.message);
    state = await getBlockState(admin);
  }
  const [listed, validation] = await Promise.all([
    listLiveAutomaticDiscounts(admin).catch(() => null),
    getValidationStatus(admin),
  ]);
  return json({
    state,
    live: listed?.discounts ?? null,
    liveComplete: listed?.complete ?? true,
    validation,
    defaultMessage: DEFAULT_MESSAGE,
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const message = String(form.get("message") ?? "");

  try {
    let state;
    if (intent === "enable") state = await enableBlock(admin, { message });
    else if (intent === "disable") state = await disableBlock(admin);
    else if (intent === "message") state = await updateMessage(admin, message);
    else if (intent === "exempt") {
      await setExempt(admin, String(form.get("id")), form.get("exempt") === "true");
      state = await getBlockState(admin);
    } else return json({ ok: false, error: "Unknown action." }, { status: 400 });
    return json({ ok: true, intent, errors: state.errors });
  } catch (err) {
    console.error(`[discount-block] ${intent} failed:`, err);
    return json({ ok: false, intent, error: err.message });
  } finally {
    // Blocking, unblocking or exempting the GWP discount changes whether the
    // storefront and checkout offer gifts; don't wait for the webhook. Runs
    // even when the action failed part way, since the flag may already have
    // changed (e.g. enabled saved, then the pause run threw).
    if (intent === "enable" || intent === "disable" || intent === "exempt") {
      try {
        await syncGWPActiveState(admin, session.shop);
      } catch (err) {
        console.error("[discount-block] GWP sync failed:", err.message);
      }
    }
  }
};

const TOASTS = {
  enable: "Discounts blocked",
  disable: "Discounts allowed again",
  message: "Message saved",
  exempt: "Saved",
};

export default function DiscountBlock() {
  const { state, live, liveComplete, validation, defaultMessage } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const [message, setMessage] = useState(state.message || defaultMessage);
  const [confirming, setConfirming] = useState(false);

  const busy = fetcher.state !== "idle";
  const pending = busy ? fetcher.formData?.get("intent") : null;
  const result = fetcher.state === "idle" ? fetcher.data : null;

  useEffect(() => {
    if (!result) return;
    if (!result.ok) shopify.toast.show(result.error || "Something went wrong", { isError: true });
    else if (result.errors?.length) shopify.toast.show("Done, with problems. See below.", { isError: true });
    else shopify.toast.show(TOASTS[result.intent] ?? "Saved");
  }, [result, shopify]);

  const submit = (intent, extra = {}) => {
    setConfirming(false);
    fetcher.submit({ intent, message, ...extra }, { method: "POST" });
  };
  // Show the checkbox change right away rather than after the reload.
  const pendingExempt =
    pending === "exempt"
      ? { id: fetcher.formData.get("id"), exempt: fetcher.formData.get("exempt") === "true" }
      : null;
  const isExempt = (d) => (pendingExempt?.id === d.id ? pendingExempt.exempt : d.exempt);

  const on = state.enabled;
  // This app's discounts stay active and are switched off by the flag; every
  // other automatic discount gets paused.
  const ours = (live ?? []).filter((d) => d.ownedByApp);
  const others = live == null ? null : live.filter((d) => !d.ownedByApp);
  // While on, no other automatic discount should be live; one that is would
  // block every checkout it applies to.
  const stillLive = on ? (others ?? []) : [];
  // On, but the checkout validation is held off (or never got created):
  // codes are still removed, but express checkout isn't blocked.
  const notFullyOn = on && (state.needsSweep || (!validation.error && !validation.enabled));
  // Off, but some paused discounts weren't restored (failed or timed out).
  const stillPaused = !on ? state.paused : [];
  const exemptCount = ours.filter((d) => d.exempt).length;
  const messageChanged = message.trim() !== (state.message || defaultMessage);

  return (
    <Page>
      <TitleBar title="Block all discounts" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {result && !result.ok && (
              <Banner tone="critical" title="That didn't work">
                <p>{result.error}</p>
              </Banner>
            )}

            {state.errors?.length > 0 && (
              <Banner tone="warning" title="Some changes didn't go through">
                <List>
                  {state.errors.map((e, i) => (
                    <List.Item key={`${e.id ?? "x"}-${i}`}>
                      <strong>{e.title}</strong>: {e.message}
                    </List.Item>
                  ))}
                </List>
              </Banner>
            )}

            {notFullyOn && stillLive.length === 0 && (
              <Banner
                tone="critical"
                title="Discounts are blocked, but not fully"
                action={{ content: "Finish turning on", onAction: () => submit("enable"), loading: pending === "enable" }}
              >
                <p>
                  Codes are still removed at checkout, but Apple Pay and Google Pay orders with a code
                  aren&apos;t stopped. The checkout check stays off until every other automatic discount is
                  confirmed paused, so it can&apos;t block orders by mistake. This page retries on each
                  load.
                </p>
              </Banner>
            )}

            {stillPaused.length > 0 && (
              <Banner
                tone="warning"
                title={`${stillPaused.length} paused discount${stillPaused.length === 1 ? " wasn't" : "s weren't"} turned back on`}
                action={{ content: "Turn them back on", onAction: () => submit("disable"), loading: pending === "disable" }}
              >
                <List>
                  {stillPaused.map((d) => (
                    <List.Item key={d.id}>{d.title}</List.Item>
                  ))}
                </List>
              </Banner>
            )}

            {!liveComplete && (
              <Banner tone="warning" title="Not every automatic discount was checked">
                <p>There are more than 1,000 automatic discounts; only the first 1,000 are listed.</p>
              </Banner>
            )}

            {stillLive.length > 0 && (
              <Banner
                tone="critical"
                title={`${stillLive.length} automatic discount${stillLive.length === 1 ? " is" : "s are"} still running`}
                action={{ content: "Pause them", onAction: () => submit("enable"), loading: pending === "enable" }}
              >
                <p>
                  These still apply on top of sale prices, and the checkout check stays off until
                  they&apos;re paused. Pause them now.
                </p>
                <List>
                  {stillLive.map((d) => (
                    <List.Item key={d.id}>{d.title}</List.Item>
                  ))}
                </List>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">Status</Text>
                    {on ? <Badge tone="critical">Discounts blocked</Badge> : <Badge>Discounts allowed</Badge>}
                  </InlineStack>
                  {on ? (
                    <Button variant="primary" loading={pending === "disable"} disabled={busy} onClick={() => setConfirming(true)}>
                      Allow discounts again
                    </Button>
                  ) : (
                    <Button variant="primary" tone="critical" loading={pending === "enable"} disabled={busy} onClick={() => setConfirming(true)}>
                      Block all discounts
                    </Button>
                  )}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {on
                    ? `Blocked since ${formatDate(state.enabledAt)}. No discount code or automatic discount applies at checkout.`
                    : "Turn this on to stop every discount from applying at checkout, for example during a sale run on sale prices."}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Message to customers</Text>
                <TextField
                  label="Shown under the discount code field at checkout while discounts are blocked"
                  value={message}
                  onChange={setMessage}
                  maxLength={200}
                  showCharacterCount
                  autoComplete="off"
                />
                <InlineStack>
                  <Button
                    onClick={() => submit("message")}
                    loading={pending === "message"}
                    disabled={busy || !messageChanged}
                  >
                    Save message
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {on ? "Paused automatic discounts" : "Automatic discounts that will be paused"}
                </Text>
                <Text as="p" tone="subdued">
                  {on
                    ? "Shopify and other apps' discounts can't be stopped from applying while they're active, so they're paused. They come back on, with their original dates, when you allow discounts again. Any whose end date passes in the meantime stay off."
                    : "Shopify and other apps' discounts can't be stopped from applying while they're active, so turning the block on pauses these. Turning it off restores them with their original dates."}
                </Text>
                <DiscountList discounts={on ? state.paused : others} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">This app&apos;s discounts</Text>
                <Text as="p" tone="subdued">
                  These stay active but give no discount while the block is on. Check one to keep it
                  working during the block. POS-only discounts always keep working in store.
                </Text>
                {live == null ? (
                  <DiscountList discounts={null} />
                ) : ours.length === 0 ? (
                  <Text as="p" tone="subdued">None.</Text>
                ) : (
                  <BlockStack gap="100">
                    {ours.map((d) => (
                      <Checkbox
                        key={d.id}
                        label={`Keep "${d.title}" working during the block`}
                        helpText={
                          [d.exemptUnsupported, d.endsAt ? `Ends ${formatDate(d.endsAt)}` : null]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                        checked={isExempt(d)}
                        disabled={busy || (!!d.exemptUnsupported && !isExempt(d))}
                        onChange={(checked) => submit("exempt", { id: d.id, exempt: String(checked) })}
                      />
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">How it works</Text>
                <List>
                  <List.Item>
                    This app&apos;s discounts (GWP, free etch and the rest) stay active but give no
                    discount, and the storefront stops offering gifts. Any you&apos;ve checked to keep
                    working still apply, and checkout lets them through.
                  </List.Item>
                  <List.Item>Other automatic discounts (Shopify&apos;s or other apps&apos;) are paused.</List.Item>
                  <List.Item>
                    Discount codes aren&apos;t changed. Checkout removes any code a customer enters and
                    shows your message.
                  </List.Item>
                  <List.Item>
                    In Apple Pay and Google Pay express checkout, where codes can&apos;t be removed
                    automatically, checkout is blocked until the customer removes the code.
                  </List.Item>
                  <List.Item>
                    POS-only discounts keep working in store. The paused discounts and this
                    app&apos;s other discounts are off on POS too. Codes entered on POS and custom
                    discounts added by staff still work.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Setup</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span">Checkout validation</Text>
                  {validation.error ? (
                    <Badge tone="critical">Error</Badge>
                  ) : validation.enabled ? (
                    <Badge tone="success">On</Badge>
                  ) : (
                    <Badge>{validation.found ? "Off" : "Created when turned on"}</Badge>
                  )}
                </InlineStack>
                {validation.error && (
                  <Text as="p" tone="critical">
                    {validation.error}. If this mentions access, open the app once to approve its new permissions.
                  </Text>
                )}
                <Text as="p">
                  The checkout block must be added once in{" "}
                  <a href="shopify://admin/settings/checkout" target="_top">Settings → Checkout → Customize</a>
                  : add the &ldquo;Block all discounts&rdquo; app block under the discount code field and
                  save. It shows nothing while discounts are allowed.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={on ? "Allow discounts again?" : "Block all discounts?"}
        primaryAction={
          on
            ? { content: "Allow discounts", onAction: () => submit("disable") }
            : { content: "Block discounts", destructive: true, onAction: () => submit("enable") }
        }
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirming(false) }]}
      >
        <Modal.Section>
          {on ? (
            <BlockStack gap="200">
              <Text as="p">Discount codes will work at checkout again.</Text>
              <Text as="p">
                {state.paused.length} paused automatic discount{state.paused.length === 1 ? "" : "s"} will
                be turned back on with their original dates.
              </Text>
            </BlockStack>
          ) : (
            <BlockStack gap="200">
              <Text as="p">
                No discount will apply at checkout until you turn this off. Customers who enter a code
                will see your message.
              </Text>
              <Text as="p">
                {(others ?? []).length} automatic discount{(others ?? []).length === 1 ? "" : "s"} will be
                paused. This app&apos;s discounts, including GWP and free etch, stay active but give
                no discount{exemptCount ? `, except ${exemptCount} you've kept working` : ""}.
              </Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function DiscountList({ discounts }) {
  if (discounts == null) return <Text as="p" tone="critical">Couldn&apos;t load discounts.</Text>;
  if (!discounts.length) return <Text as="p" tone="subdued">None.</Text>;
  return (
    <List>
      {discounts.map((d) => (
        <List.Item key={d.id}>
          {d.title}
          {d.app ? ` (${d.app})` : ""}
          {d.endsAt ? ` · ends ${formatDate(d.endsAt)}` : ""}
        </List.Item>
      ))}
    </List>
  );
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
