import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";

  const res = await admin.graphql(
    `query SearchSegments($query: String) {
      segments(first: 20, query: $query) {
        edges {
          node {
            id
            name
          }
        }
      }
    }`,
    { variables: { query: query || null } }
  );

  const data = await res.json();
  const segments = (data.data?.segments?.edges ?? []).map((e) => e.node);

  return json({ segments });
};
