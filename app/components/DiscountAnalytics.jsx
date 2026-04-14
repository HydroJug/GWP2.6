import { useState, useEffect } from "react";
import { IndexTable, Text, Spinner, Tooltip } from "@shopify/polaris";

/**
 * Hook that fetches analytics for a list of discounts.
 * Returns a map of discount ID → analytics data.
 */
export function useDiscountAnalytics(discounts) {
  const [analytics, setAnalytics] = useState({});

  useEffect(() => {
    if (!discounts?.length) return;
    let cancelled = false;

    async function fetchAll() {
      const results = {};
      // Fetch in parallel batches of 5
      for (let i = 0; i < discounts.length; i += 5) {
        const batch = discounts.slice(i, i + 5);
        const promises = batch.map(async (d) => {
          const params = new URLSearchParams();
          if (d.code) params.set("code", d.code);
          params.set("title", d.title);
          try {
            const res = await fetch(`/api/discount-analytics?${params}`);
            const data = await res.json();
            return { id: d.id, data };
          } catch {
            return { id: d.id, data: null };
          }
        });
        const batchResults = await Promise.all(promises);
        for (const r of batchResults) {
          if (!cancelled) results[r.id] = r.data;
        }
      }
      if (!cancelled) setAnalytics(results);
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [discounts]);

  return analytics;
}

function fmt(val) {
  if (val === undefined || val === null) return "—";
  return `$${parseFloat(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Analytics cells for an IndexTable row.
 * Pass the analytics object for a single discount (or null if still loading).
 */
export function AnalyticsCells({ data }) {
  if (data === undefined) {
    return (
      <>
        <IndexTable.Cell><Spinner size="small" /></IndexTable.Cell>
        <IndexTable.Cell />
        <IndexTable.Cell />
        <IndexTable.Cell />
        <IndexTable.Cell />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <IndexTable.Cell><Text tone="subdued">—</Text></IndexTable.Cell>
        <IndexTable.Cell />
        <IndexTable.Cell />
        <IndexTable.Cell />
        <IndexTable.Cell />
      </>
    );
  }

  return (
    <>
      <IndexTable.Cell>
        <Text as="span">
          {data.timesUsed}{data.capped ? "+" : ""}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span">{fmt(data.grossRevenue)}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="critical">{fmt(data.discountAmount)}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">
          {parseFloat(data.otherDiscounts) > 0 ? fmt(data.otherDiscounts) : "—"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" fontWeight="semibold">{fmt(data.netRevenue)}</Text>
      </IndexTable.Cell>
    </>
  );
}

/** Standard analytics column headings to append to your IndexTable headings. */
export const analyticsHeadings = [
  { title: "Uses" },
  { title: "Gross revenue" },
  { title: "Discount amt" },
  { title: "Other discounts" },
  { title: "Net revenue" },
];
