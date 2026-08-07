"use client";

import { useCallback, useEffect, useState } from "react";

interface DueInvoiceItem {
  invoiceId: string;
  invoiceNumber?: string;
  vendorName?: string;
  dueDate: string;
  totalAmount?: number;
  currency?: string;
}

interface DueInvoicesResponse {
  success: boolean;
  windowDays: number;
  overdue: DueInvoiceItem[];
  dueSoon: DueInvoiceItem[];
  error?: string;
}

function formatDueDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function formatAmount(item: DueInvoiceItem) {
  if (item.totalAmount == null) return "—";
  return `${item.currency ?? ""} ${item.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function InvoiceRow({
  item,
  tone,
  onMarkPaid,
  markingId,
}: {
  item: DueInvoiceItem;
  tone: "overdue" | "soon";
  onMarkPaid: (invoiceId: string) => void;
  markingId: string | null;
}) {
  const isMarking = markingId === item.invoiceId;
  const dueDateClass =
    tone === "overdue" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-100 py-2.5 last:border-0 dark:border-zinc-800">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
          {item.vendorName ?? "Unknown vendor"}
          {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
        </p>
        <p className={`text-xs ${dueDateClass}`}>Due {formatDueDate(item.dueDate)}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {formatAmount(item)}
        </span>
        <button
          type="button"
          onClick={() => onMarkPaid(item.invoiceId)}
          disabled={isMarking}
          className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950"
        >
          {isMarking ? "Marking…" : "Mark Paid"}
        </button>
      </div>
    </div>
  );
}

export function PaymentsDueList() {
  const [data, setData] = useState<DueInvoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/invoices/due");
      const json = await response.json();
      if (!json.success) throw new Error(json.error ?? "Failed to load payments due");
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payments due");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleMarkPaid(invoiceId: string) {
    setMarkingId(invoiceId);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/payment-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentStatus: "PAID" }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error ?? "Failed to mark invoice paid");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark invoice paid");
    } finally {
      setMarkingId(null);
    }
  }

  if (loading) {
    return (
      <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
        Failed to load payments due: {error}
      </div>
    );
  }

  if (!data) return null;

  const { overdue, dueSoon, windowDays } = data;

  return (
    <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium text-red-600 dark:text-red-400">
          Overdue ({overdue.length})
        </h2>
        {overdue.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No overdue invoices.</p>
        ) : (
          <div className="mt-2 max-h-[170px] overflow-y-auto overflow-x-hidden pr-1">
            {overdue.map((item) => (
              <InvoiceRow
                key={item.invoiceId}
                item={item}
                tone="overdue"
                onMarkPaid={handleMarkPaid}
                markingId={markingId}
              />
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium text-amber-600 dark:text-amber-400">
          Due within {windowDays} days ({dueSoon.length})
        </h2>
        {dueSoon.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Nothing due within {windowDays} days.
          </p>
        ) : (
          <div className="mt-2 max-h-[170px] overflow-y-auto overflow-x-hidden pr-1">
            {dueSoon.map((item) => (
              <InvoiceRow
                key={item.invoiceId}
                item={item}
                tone="soon"
                onMarkPaid={handleMarkPaid}
                markingId={markingId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
