import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/POSChannelTile.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.tile.render').Api;
  const globalThis: { shopify: typeof shopify };
}
