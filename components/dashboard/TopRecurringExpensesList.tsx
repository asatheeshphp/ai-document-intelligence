import type { LineItemGroupResult } from "@/services/dashboard-analytics.service";

function formatAmount(item: LineItemGroupResult): string {
  const formatted = item.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return item.currency ? `${item.currency} ${formatted}` : formatted;
}

export function TopRecurringExpensesList({ data }: { data: LineItemGroupResult[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Top Recurring Expenses</h2>
      {data.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No recurring expenses found yet.</p>
      ) : (
        <div className="mt-2">
          {data.map((item) => (
            <div
              key={item.description}
              className="flex items-center justify-between gap-3 border-b border-zinc-100 py-2.5 last:border-0 dark:border-zinc-800"
            >
              <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{item.description}</span>
              <span className="flex-shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
                {item.invoiceCount} invoice{item.invoiceCount === 1 ? "" : "s"} · {formatAmount(item)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
