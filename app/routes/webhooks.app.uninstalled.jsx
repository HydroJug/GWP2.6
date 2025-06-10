import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Note: Using memory session storage, so sessions are automatically cleaned up
  // when the app restarts. No database cleanup needed.

  return new Response();
};
