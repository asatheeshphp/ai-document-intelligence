"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { VendorComparisonEntry } from "@/services/dashboard-analytics.service";

const BRAND_ORANGE = "#F5720C";

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
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
              <YAxis dataKey="vendorName" type="category" tick={{ fontSize: 12 }} stroke="#a1a1aa" width={140} />
              <Tooltip />
              <Bar dataKey="amount" fill={BRAND_ORANGE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
