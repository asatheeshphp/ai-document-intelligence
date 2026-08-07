import { StatusBadge } from "@/components/documents/StatusBadge";

export interface DocumentSummaryItem {
  documentId: string;
  filename?: string;
  status: string;
  createdAt: string;
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
  invoiceDate?: string;
  totalAmount?: number;
  currency?: string;
  chunkCount: number;
}

interface DocumentsTableProps {
  items: DocumentSummaryItem[];
  onView: (documentId: string) => void;
  onReindex: (documentId: string) => void;
  onProcessAnyway: (documentId: string) => void;
  onDeleteClick: (documentId: string) => void;
  onCancelDelete: () => void;
  reindexingId: string | null;
  processingAnywayId: string | null;
  confirmingDeleteId: string | null;
  deletingId: string | null;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function formatAmount(value?: number, currency?: string) {
  if (value == null) return "—";
  const formatted = value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${formatted}` : formatted;
}

export function DocumentsTable({
  items,
  onView,
  onReindex,
  onProcessAnyway,
  onDeleteClick,
  onCancelDelete,
  reindexingId,
  processingAnywayId,
  confirmingDeleteId,
  deletingId,
}: DocumentsTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead>
          <tr className="text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <th className="px-4 py-3">Invoice Number</th>
            <th className="px-4 py-3">Supplier</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Invoice Date</th>
            <th className="px-4 py-3 text-right">Grand Total</th>
            <th className="px-4 py-3 text-right">Chunks</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {items.map((item) => {
            const isConfirmingDelete = confirmingDeleteId === item.documentId;
            const isDeleting = deletingId === item.documentId;
            const isProcessingAnyway = processingAnywayId === item.documentId;
            const isDuplicateReview = item.status === "DUPLICATE_REVIEW";

            return (
              <tr key={item.documentId} className="text-zinc-700 dark:text-zinc-300">
                <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                  {item.invoiceNumber ?? "—"}
                </td>
                <td className="px-4 py-3">{item.vendorName ?? "—"}</td>
                <td className="px-4 py-3">{item.customerName ?? "—"}</td>
                <td className="px-4 py-3">{formatDate(item.invoiceDate)}</td>
                <td className="px-4 py-3 text-right">{formatAmount(item.totalAmount, item.currency)}</td>
                <td className="px-4 py-3 text-right">{item.chunkCount}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={item.status} />
                </td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  {formatDate(item.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    {isConfirmingDelete ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onDeleteClick(item.documentId)}
                          disabled={isDeleting}
                          className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                        >
                          {isDeleting ? "Deleting…" : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          onClick={onCancelDelete}
                          disabled={isDeleting}
                          className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onView(item.documentId)}
                          className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          View
                        </button>
                        {isDuplicateReview && (
                          <button
                            type="button"
                            onClick={() => onProcessAnyway(item.documentId)}
                            disabled={isProcessingAnyway}
                            title="A matching invoice already exists (same vendor, number, and date) -- create this one anyway"
                            className="rounded-md border border-orange-200 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-900 dark:text-orange-400 dark:hover:bg-orange-950"
                          >
                            {isProcessingAnyway ? "Processing…" : "Process Anyway"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onDeleteClick(item.documentId)}
                          className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
