"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { VendorComparisonEntry } from "@/services/dashboard-analytics.service";

const BRAND_ORANGE = "#F5720C";
// Confirmed live: at width=140/fontSize=12, Recharts still word-wraps a category label
// onto 2 lines once it exceeds roughly 16-17 characters (average glyph width, not a
// hard character count) -- the earlier 20-char limit was still wide enough to wrap for
// several real vendor names, producing uneven, ellipsis-mid-wrap labels. 16 keeps the
// truncated label reliably on one line at this width/font size.
const MAX_LABEL_CHARS = 16;

// Confirmed live: real vendor names (e.g. "*ASSPL-Amazon Seller Services Pvt. Ltd.,
// ARIPL-Amazon Retail India Pvt. Ltd.") wrap to 2-3 lines at the fixed YAxis width, and
// with several categories the wrapped lines overlap the adjacent category's label,
// making both unreadable. Truncating to a single line (full name still available via
// the Tooltip on hover) avoids the overlap regardless of how long a name is, rather than
// guessing a "big enough" per-row height that a longer name would break again.
function truncateLabel(value: string): string {
  return value.length > MAX_LABEL_CHARS ? `${value.slice(0, MAX_LABEL_CHARS - 1)}…` : value;
}

function formatAxisAmount(value: number): string {
  return value.toLocaleString();
}

export function VendorComparisonChart({ data }: { data: VendorComparisonEntry[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Vendor Comparison</h2>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No vendor spend data yet.</p>
      ) : (
        <div className="mt-4" style={{ height: Math.max(160, data.length * 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="#a1a1aa" tickFormatter={formatAxisAmount} />
              <YAxis
                dataKey="vendorName"
                type="category"
                tick={{ fontSize: 12 }}
                stroke="#a1a1aa"
                width={140}
                tickFormatter={truncateLabel}
              />
              <Tooltip />
              <Bar dataKey="amount" fill={BRAND_ORANGE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
