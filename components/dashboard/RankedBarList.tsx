"use client";

export interface RankedBarSegment {
  key: string;
  label: string;
  amount: number;
  color: string;
}

export interface RankedBarListEntry {
  label: string;
  currency: string | null;
  segments: RankedBarSegment[];
}

function formatAmount(amount: number, currency: string | null): string {
  const formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${formatted}` : formatted;
}

export function RankedBarList({
  title,
  data,
  emptyMessage,
}: {
  title: string;
  data: RankedBarListEntry[];
  emptyMessage: string;
}) {
  // Same scale across every bar in the list (not just within one row) -- otherwise a
  // vendor with a small Paid amount but a huge Unpaid amount would render its Paid bar
  // at the same visual width as another vendor's much larger Paid amount, since each row
  // would be scaling against its own max instead of a shared one.
  const maxSegmentAmount = Math.max(...data.flatMap((entry) => entry.segments.map((segment) => segment.amount)), 0);

  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</h2>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">{emptyMessage}</p>
      ) : (
        <ul className="mt-4 flex max-h-[380px] flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1">
          {data.map((entry, index) => {
            const total = entry.segments.reduce((sum, segment) => sum + segment.amount, 0);
            const isSingleSegment = entry.segments.length === 1;

            return (
              <li
                key={`${entry.label}-${index}`}
                className="group rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                title={`${entry.label}: ${formatAmount(total, entry.currency)}`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-300">
                    {entry.label}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-50">
                    {formatAmount(total, entry.currency)}
                  </span>
                </div>
                <div className="mt-1.5 ml-9 flex flex-col gap-1">
                  {entry.segments.map((segment) => {
                    const widthPct =
                      maxSegmentAmount > 0 ? Math.max((segment.amount / maxSegmentAmount) * 100, segment.amount > 0 ? 3 : 0) : 0;
                    return (
                      <div key={segment.key} className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div
                            className="h-2 rounded-full transition-[width] duration-300"
                            style={{ width: `${widthPct}%`, backgroundColor: segment.color }}
                          />
                        </div>
                        {!isSingleSegment && (
                          <span className="w-40 shrink-0 whitespace-nowrap text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                            {segment.label} {formatAmount(segment.amount, entry.currency)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
