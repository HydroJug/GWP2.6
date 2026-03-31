import { useEffect, useRef } from "react";
import {
  reactExtension,
  useApi,
  useCartSubscription,
  Tile,
} from "@shopify/ui-extensions-react/point-of-sale";

const CHANNEL_KEY = "channel";
const CHANNEL_VALUE = "pos";

function POSChannelTile() {
  const api = useApi();
  const cart = useCartSubscription();

  // Use a ref to avoid re-running the effect if the API reference changes
  // but the cart properties already have the correct value.
  const lastSetRef = useRef(false);

  useEffect(() => {
    const current = cart?.properties?.[CHANNEL_KEY];
    if (current !== CHANNEL_VALUE) {
      lastSetRef.current = false;
    }
    if (!lastSetRef.current) {
      api.cart
        .addCartProperties({ [CHANNEL_KEY]: CHANNEL_VALUE })
        .then(() => {
          lastSetRef.current = true;
        })
        .catch(() => {
          lastSetRef.current = false;
        });
    }
  }, [cart?.properties]);

  return (
    <Tile
      title="POS Mode"
      subtitle="Active"
      enabled={false}
    />
  );
}

export default reactExtension("pos.home.tile.render", () => (
  <POSChannelTile />
));
