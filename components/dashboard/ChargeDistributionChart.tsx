"use client";

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { ChargeDistribution } from "@/services/dashboard-analytics.service";

const SLICE_COLORS: Record<string, string> = {
  Subtotal: "#F5720C",
  Tax: "#6366F1",
  Discount: "#38BDF8",
  Shipping: "#A78BFA",
};

// Confirmed live: summing many invoices' tax/subtotal/shipping fields (plain JS
// floating-point addition) produces artifacts like 9942.519999999999 -- correct to the
// cent, but unpresentable raw. The default Tooltip renders the raw number verbatim, so
// this formats it the same way every other currency figure on the dashboard already is
// (fixed 2 decimal places).
function formatTooltipValue(value: number | string | readonly (number | string)[] | undefined): string {
  return typeof value === "number"
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(value ?? "");
}

export function ChargeDistributionChart({ data }: { data: ChargeDistribution }) {
  const slices = [
    { name: "Subtotal", value: data.subtotal },
    { name: "Tax", value: data.tax },
    { name: "Discount", value: data.discount },
    { name: "Shipping", value: data.shipping },
  ].filter((slice) => slice.value > 0);

  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Charge Distribution</h2>
      {slices.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No charge data yet.</p>
      ) : (
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {slices.map((slice) => (
                  <Cell key={slice.name} fill={SLICE_COLORS[slice.name]} />
                ))}
              </Pie>
              <Legend verticalAlign="bottom" height={24} />
              <Tooltip formatter={formatTooltipValue} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
