import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';

// Checkout half of "Block all discounts" (app/lib/discountBlock.server.js).
// While the toggle is on, removes every discount code the customer enters (or
// brings from the cart / a link) and explains why. Codes can't be removed in
// Apple Pay / Google Pay express checkout; the discount-block-validation
// function blocks those checkouts instead.

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const config = readConfig(shopify.appMetafields.value);
  const codes = shopify.discountCodes.value.map((discount) => discount.code);
  const canRemove = shopify.instructions.value.discounts.canUpdateDiscountCodes;
  const enabled = config.enabled === true;

  const [removed, setRemoved] = useState([]);
  // Codes already tried, so a failed removal isn't retried on every render.
  const attempted = useRef(new Set());

  const codesKey = codes.join('\n');
  useEffect(() => {
    if (!enabled || !canRemove) return;
    for (const code of codes) {
      const id = code.toLowerCase();
      if (attempted.current.has(id)) continue;
      attempted.current.add(id);
      shopify
        .applyDiscountCodeChange({type: 'removeDiscountCode', code})
        .then((result) => {
          if (result.type === 'success') {
            setRemoved((prev) => (prev.includes(code) ? prev : [...prev, code]));
            // Allow removing it again if the customer re-enters it.
            attempted.current.delete(id);
          } else {
            console.warn('[discount-block] could not remove code', code, result.message);
          }
        })
        .catch((error) => console.warn('[discount-block] could not remove code', code, error));
    }
  }, [enabled, canRemove, codesKey]);

  if (!enabled) return null;

  const message =
    (typeof config.message === 'string' && config.message.trim()) ||
    shopify.i18n.translate('defaultMessage');

  return (
    <s-banner tone={removed.length ? 'warning' : 'info'}>
      <s-stack gap="small-200">
        <s-text>{message}</s-text>
        {removed.length > 0 && (
          <s-text color="subdued">
            {shopify.i18n.translate('removedCodes', {codes: removed.join(', ')})}
          </s-text>
        )}
      </s-stack>
    </s-banner>
  );
}

/** The { enabled, message } shop metafield the app writes. */
function readConfig(entries) {
  const entry = entries.find(
    ({target, metafield}) =>
      target.type === 'shop' &&
      metafield.key === 'config' &&
      metafield.namespace.endsWith('discount_block'),
  );
  if (!entry) return {};
  try {
    const value = JSON.parse(String(entry.metafield.value));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
