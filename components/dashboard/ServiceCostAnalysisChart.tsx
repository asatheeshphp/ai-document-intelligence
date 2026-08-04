"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LineItemGroupResult } from "@/services/dashboard-analytics.service";

const SERVICE_INDIGO = "#6366F1";
const MAX_LABEL_CHARS = 20;

// Confirmed live: real line-item descriptions (e.g. "Transportation Coimbatore →
// Chennai (12 Tons)") wrap to 2-3 lines at the fixed YAxis width, and with several
// categories the wrapped lines overlap the adjacent category's label, making both
// unreadable. Truncating to a single line (full description still available via the
// Tooltip on hover) avoids the overlap regardless of how long a description is, rather
// than guessing a "big enough" per-row height that a longer description would break
// again.
function truncateLabel(value: string): string {
  return value.length > MAX_LABEL_CHARS ? `${value.slice(0, MAX_LABEL_CHARS - 1)}…` : value;
}

export function ServiceCostAnalysisChart({ data }: { data: LineItemGroupResult[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Service Cost Analysis</h2>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No line-item data yet.</p>
      ) : (
        <div className="mt-4" style={{ height: Math.max(160, data.length * 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
              <YAxis
                dataKey="description"
                type="category"
                tick={{ fontSize: 12 }}
                stroke="#a1a1aa"
                width={140}
                tickFormatter={truncateLabel}
              />
              <Tooltip />
              <Bar dataKey="amount" fill={SERVICE_INDIGO} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
