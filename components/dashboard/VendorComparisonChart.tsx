"use client";

import { RankedBarList } from "@/components/dashboard/RankedBarList";
import type { VendorComparisonEntry } from "@/services/dashboard-analytics.service";

const PAID_COLOR = "#10B981";
const UNPAID_COLOR = "#DC2626";

export function VendorComparisonChart({ data }: { data: VendorComparisonEntry[] }) {
  return (
    <RankedBarList
      title="Vendor Comparison"
      emptyMessage="No vendor spend data yet."
      data={data.map((entry) => ({
        label: entry.vendorName,
        currency: entry.currency,
        segments: [
          { key: "paid", label: "Paid", amount: entry.paid, color: PAID_COLOR },
          { key: "unpaid", label: "Unpaid", amount: entry.unpaid, color: UNPAID_COLOR },
        ],
      }))}
    />
  );
}
