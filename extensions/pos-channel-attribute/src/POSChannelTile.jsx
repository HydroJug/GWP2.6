import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef} from 'preact/hooks';

// Marks every POS cart with the cart attribute channel=pos, which the
// pos-only-discount and tapcart-discount-function functions read.
const CHANNEL_KEY = 'channel';
const CHANNEL_VALUE = 'pos';

export default async () => {
  render(<POSChannelTile />, document.body);
};

function POSChannelTile() {
  const current = shopify.cart.current.value?.properties?.[CHANNEL_KEY];
  // Avoids re-sending while a write is in flight or already applied.
  const lastSet = useRef(false);

  useEffect(() => {
    if (current !== CHANNEL_VALUE) lastSet.current = false;
    if (lastSet.current) return;
    lastSet.current = true;
    shopify.cart.addCartProperties({[CHANNEL_KEY]: CHANNEL_VALUE}).catch(() => {
      lastSet.current = false;
    });
  }, [current]);

  return <s-tile heading="POS Mode" subheading="Active" disabled />;
}
