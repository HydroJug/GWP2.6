import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";

  if (!query || query.length < 2) {
    return json({ customers: [] });
  }

  const res = await admin.graphql(
    `query SearchCustomers($query: String!) {
      customers(first: 10, query: $query) {
        edges {
          node {
            id
            displayName
            email
          }
        }
      }
    }`,
    { variables: { query } }
  );

  const data = await res.json();
  const customers = (data.data?.customers?.edges ?? []).map((e) => e.node);

  return json({ customers });
};
