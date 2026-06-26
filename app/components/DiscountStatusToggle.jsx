import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { Button } from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Activate / deactivate toggle for a single discount.
 *
 * Reusable across discount lists (inside an IndexTable row) and detail pages.
 * Posts to /api/toggle-discount and revalidates the current route on success
 * so the status reflects immediately.
 *
 * Props:
 *   discountId   – discount node GID
 *   discountType – "automatic" | "code"
 *   status       – current DiscountStatus ("ACTIVE", "EXPIRED", "SCHEDULED", …)
 *   size         – Polaris Button size (default "slim")
 *   inRow        – when true, stops click propagation so it doesn't trigger the
 *                  IndexTable row's navigation onClick.
 */
export default function DiscountStatusToggle({
  discountId,
  discountType = "automatic",
  status,
  size = "slim",
  inRow = false,
}) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const lastHandled = useRef(null);

  const isActive = status === "ACTIVE";
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data || fetcher.data === lastHandled.current) return;
    lastHandled.current = fetcher.data;
    if (fetcher.data.success) {
      shopify?.toast?.show(
        fetcher.data.activated ? "Discount activated" : "Discount deactivated"
      );
      revalidator.revalidate();
    } else if (fetcher.data.error) {
      shopify?.toast?.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify, revalidator]);

  const handleClick = (e) => {
    if (inRow) e?.stopPropagation?.();
    const fd = new FormData();
    fd.append("discountId", discountId);
    fd.append("discountType", discountType);
    fd.append("activate", String(!isActive));
    fetcher.submit(fd, { method: "POST", action: "/api/toggle-discount" });
  };

  const content = (
    <Button
      size={size}
      loading={busy}
      tone={isActive ? "critical" : "success"}
      onClick={handleClick}
    >
      {isActive ? "Deactivate" : "Activate"}
    </Button>
  );

  // Wrap in a stop-propagation span so clicking the button inside a clickable
  // table row doesn't also navigate to the detail page.
  return inRow ? (
    <span onClick={(e) => e.stopPropagation()}>{content}</span>
  ) : (
    content
  );
}
