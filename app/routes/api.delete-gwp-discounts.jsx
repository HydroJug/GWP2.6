import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Delete/deactivate all discounts tied to the GWP function:
// - Automatic discounts: delete
// - Code discounts: deactivate (not delete)
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const body = await request.json().catch(() => ({}));
    let { functionId } = body || {};

    // If no functionId provided, try to detect the GWP function id
    if (!functionId) {
      const fnResp = await admin.graphql(
        `#graphql
          query {
            shopifyFunctions(first: 50) {
              nodes {
                id
                title
                apiType
              }
            }
          }`
      );
      const fnData = await fnResp.json();
      const gwpFn = fnData.data?.shopifyFunctions?.nodes?.find(
        (n) =>
          n.apiType === "discount" &&
          (n.title?.toLowerCase().includes("gwp") ||
            n.title?.toLowerCase().includes("gift") ||
            n.title?.toLowerCase().includes("tier"))
      );
      functionId = gwpFn?.id || null;
    }

    if (!functionId) {
      return json({ deleted: 0, message: "No functionId provided or detected." }, { status: 400 });
    }

    // List automatic discounts
    const listResp = await admin.graphql(
      `#graphql
        query {
          discountNodes(first: 250) {
            nodes {
              id
              discount {
                ... on DiscountAutomaticApp {
                  title
                  status
                  appDiscountType {
                    functionId
                  }
                }
              }
            }
          }
        }`
    );
    const listData = await listResp.json();
    const nodes = listData.data?.discountNodes?.nodes || [];

    const targets = nodes.filter((node) => {
      const fnId = node.discount?.appDiscountType?.functionId;
      return fnId === functionId;
    });

    // List code discounts to deactivate (match titles containing GWP/Gift/Tier)
    const codeListResp = await admin.graphql(
      `#graphql
        query {
          codeDiscountNodes(first: 250, query: "GWP OR Gift OR Tier") {
            nodes { id codeDiscount { ... on DiscountCodeBasic { title } } }
          }
        }`
    );
    const codeListData = await codeListResp.json();
    const codeTargets = codeListData.data?.codeDiscountNodes?.nodes || [];

    // Deactivate automatic discounts (instead of deleting)
    const deactivateAutomaticMutation = `#graphql
      mutation discountAutomaticAppUpdate($id: ID!, $status: DiscountStatus!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: { status: $status }) {
          automaticAppDiscount { id status }
          userErrors { field message }
        }
      }`;

    const deactivateCodeMutation = `#graphql
      mutation deactivateCode($id: ID!) {
        discountCodeDeactivate(id: $id) {
          userErrors { message }
        }
      }`;

    let deactivatedAutomatic = 0;
    for (const node of targets) {
      try {
        const resp = await admin.graphql(deactivateAutomaticMutation, {
          variables: { id: node.id, status: "DISABLED" },
        });
        const data = await resp.json();
        if (!data.data?.discountAutomaticAppUpdate?.userErrors?.length) {
          deactivatedAutomatic++;
        }
      } catch (err) {
        console.error("Error deleting discount", node.id, err);
      }
    }

    let deactivated = 0;
    for (const node of codeTargets) {
      try {
        const resp = await admin.graphql(deactivateCodeMutation, {
          variables: { id: node.id },
        });
        const data = await resp.json();
        if (!data.data?.discountCodeDeactivate?.userErrors?.length) {
          deactivated++;
        }
      } catch (err) {
        console.error("Error deactivating code discount", node.id, err);
      }
    }

    return json({
      deactivatedAutomatic,
      deactivatedCodes: deactivated,
      functionId,
      attemptedAutomatic: targets.length,
      attemptedCodes: codeTargets.length,
    });
  } catch (error) {
    console.error("Error deleting GWP discounts:", error);
    return json({ error: "Internal error" }, { status: 500 });
  }
};

export const loader = async () => json({ error: "Use POST" }, { status: 405 });

