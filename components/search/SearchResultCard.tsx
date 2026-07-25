import { getHighlightSegments } from "@/components/search/highlight";

export interface SearchResultItem {
  invoiceId: string;
  documentId: string;
  chunkId?: string;
  chunkType?: string;
  chunkText: string;
  score: number;
  invoice: {
    invoiceNumber?: string;
    vendorName?: string;
    customerName?: string;
    invoiceDate?: string;
    totalAmount?: number;
  } | null;
}

interface SearchResultCardProps {
  result: SearchResultItem;
  query: string;
}

const CHUNK_TYPE_LABELS: Record<string, string> = {
  header: "Header",
  supplier: "Supplier",
  customer: "Customer",
  line_items: "Line Items",
  taxes: "Taxes",
  payment: "Payment",
  notes: "Notes",
  footer: "Footer",
  other: "Other",
};

export function SearchResultCard({ result, query }: SearchResultCardProps) {
  const segments = getHighlightSegments(result.chunkText, query);
  const isSemanticOnly = segments.length > 0 && segments.every((segment) => !segment.match);
  const chunkTypeLabel = result.chunkType
    ? (CHUNK_TYPE_LABELS[result.chunkType] ?? result.chunkType)
    : "Other";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {chunkTypeLabel}
          </span>
          {result.invoice?.invoiceNumber && (
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {result.invoice.invoiceNumber}
            </span>
          )}
          {result.invoice?.vendorName && (
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {result.invoice.vendorName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isSemanticOnly && (
            <span
              title="No exact keyword overlap — ranked by meaning alone"
              className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400"
            >
              Matched by meaning
            </span>
          )}
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            {(result.score * 100).toFixed(1)}% match
          </span>
        </div>
      </div>

      <p className="mt-3 whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
        {segments.map((segment, index) =>
          segment.match ? (
            <mark
              key={index}
              className="rounded bg-yellow-200 px-0.5 text-zinc-900 dark:bg-yellow-500/40 dark:text-zinc-50"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </p>
    </div>
  );
}
