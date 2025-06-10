import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  // Note: Using memory session storage, so scope updates are handled automatically
  // No database update needed.

  return new Response();
};
