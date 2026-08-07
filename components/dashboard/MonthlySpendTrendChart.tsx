"use client";

import { useState } from "react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthlyTrendSeries } from "@/services/dashboard-analytics.service";

const PAID_COLOR = "#10B981";
const UNPAID_COLOR = "#DC2626";

const SERIES_LABELS: Record<string, string> = {
  paid: "Paid",
  unpaid: "Unpaid",
};

function formatAxisAmount(value: number): string {
  return value.toLocaleString();
}

export function MonthlySpendTrendChart({ data }: { data: MonthlyTrendSeries[] }) {
  const [activeCurrency, setActiveCurrency] = useState(data[0]?.currency);
  const activeSeries = data.find((series) => series.currency === activeCurrency) ?? data[0];

  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Monthly Spending Trend</h2>
        {data.length > 1 && (
          <div className="flex gap-1">
            {data.map((series) => (
              <button
                key={series.currency}
                type="button"
                onClick={() => setActiveCurrency(series.currency)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  series.currency === activeSeries?.currency
                    ? "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {series.currency}
              </button>
            ))}
          </div>
        )}
      </div>
      {!activeSeries ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No spend data yet.</p>
      ) : (
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activeSeries.points} barGap={4}>
              <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
              <YAxis tick={{ fontSize: 12 }} stroke="#a1a1aa" tickFormatter={formatAxisAmount} />
              <Tooltip
                formatter={(value: unknown, name: unknown) => [
                  `${activeSeries.currency} ${formatAxisAmount(Number(value) || 0)}`,
                  SERIES_LABELS[String(name)] ?? String(name),
                ]}
              />
              <Legend formatter={(value: string) => SERIES_LABELS[value] ?? value} />
              <Bar dataKey="paid" fill={PAID_COLOR} radius={[4, 4, 0, 0]} barSize={16} />
              <Bar dataKey="unpaid" fill={UNPAID_COLOR} radius={[4, 4, 0, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
