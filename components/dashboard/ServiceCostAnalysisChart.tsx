"use client";

import { RankedBarList } from "@/components/dashboard/RankedBarList";
import type { LineItemGroupResult } from "@/services/dashboard-analytics.service";

const SERVICE_INDIGO = "#6366F1";

export function ServiceCostAnalysisChart({ data }: { data: LineItemGroupResult[] }) {
  return (
    <RankedBarList
      title="Service Cost Analysis"
      emptyMessage="No line-item data yet."
      data={data.map((entry) => ({
        label: entry.description,
        currency: entry.currency,
        segments: [{ key: "amount", label: "Amount", amount: entry.amount, color: SERVICE_INDIGO }],
      }))}
    />
  );
}
