import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  
  return json({
    appUrl: appUrl
  });
}; 