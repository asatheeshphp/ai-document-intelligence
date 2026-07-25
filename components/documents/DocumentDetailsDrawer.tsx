"use client";

import { useEffect, useState } from "react";

interface DocumentDetail {
  document: {
    id: string;
    filename?: string;
    documentType: string;
    status: string;
    extractedText?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  invoice: {
    id: string;
    invoiceNumber?: string;
    vendorName?: string;
    customerName?: string;
    invoiceDate?: string;
    dueDate?: string;
    poNumber?: string;
    currency?: string;
    subtotal?: number;
    taxAmount?: number;
    totalAmount?: number;
    status: string;
    extractedData: Record<string, unknown>;
    metadata: Record<string, unknown>;
  } | null;
  chunks: Array<{
    id: string;
    index: number;
    chunkType?: string;
    text: string;
    tokenCount?: number;
    metadata: Record<string, unknown>;
    embeddingDimension: number | null;
    embeddingModel: string | null;
    embeddingStatus: string | null;
    createdAt: string;
  }>;
  embeddingsSummary: {
    totalEmbeddings: number;
    embeddingModel: string | null;
    dimension: number | null;
  };
  timeline: Array<{
    type: string;
    status: string;
    modelName?: string;
    lastError?: string | null;
    createdAt: string;
  }>;
}

interface DocumentDetailsDrawerProps {
  documentId: string | null;
  onClose: () => void;
}

export function DocumentDetailsDrawer({ documentId, onClose }: DocumentDetailsDrawerProps) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The parent remounts this component (via a `key` on documentId) whenever the
  // selected document changes, so detail/error naturally start fresh — no manual
  // reset needed here. Nothing before the first `await` sets state, so this is
  // safe to call directly from the effect (avoids react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!documentId) return;

    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/documents/${documentId}`);
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error ?? "Failed to load document details");
        }
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load document details");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!documentId) return null;

  const loading = !detail && !error;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white p-6 shadow-xl dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Document Details</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        {loading && (
          <div className="mt-6 space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-16 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && detail && (
          <div className="mt-6 space-y-6">
            <section>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Summary</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-zinc-500 dark:text-zinc-400">Filename</dt>
                <dd className="text-zinc-900 dark:text-zinc-50">{detail.document.filename ?? "—"}</dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Status</dt>
                <dd className="text-zinc-900 dark:text-zinc-50">{detail.document.status}</dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Created</dt>
                <dd className="text-zinc-900 dark:text-zinc-50">
                  {new Date(detail.document.createdAt).toLocaleString()}
                </dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Updated</dt>
                <dd className="text-zinc-900 dark:text-zinc-50">
                  {new Date(detail.document.updatedAt).toLocaleString()}
                </dd>
              </dl>
            </section>

            {detail.invoice && (
              <section>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Invoice</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-zinc-500 dark:text-zinc-400">Invoice #</dt>
                  <dd className="text-zinc-900 dark:text-zinc-50">
                    {detail.invoice.invoiceNumber ?? "—"}
                  </dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">Supplier</dt>
                  <dd className="text-zinc-900 dark:text-zinc-50">
                    {detail.invoice.vendorName ?? "—"}
                  </dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">Customer</dt>
                  <dd className="text-zinc-900 dark:text-zinc-50">
                    {detail.invoice.customerName ?? "—"}
                  </dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">Invoice Date</dt>
                  <dd className="text-zinc-900 dark:text-zinc-50">
                    {detail.invoice.invoiceDate
                      ? new Date(detail.invoice.invoiceDate).toLocaleDateString()
                      : "—"}
                  </dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">Grand Total</dt>
                  <dd className="text-zinc-900 dark:text-zinc-50">
                    {detail.invoice.totalAmount != null
                      ? `${detail.invoice.currency ?? ""} ${detail.invoice.totalAmount}`.trim()
                      : "—"}
                  </dd>
                </dl>
              </section>
            )}

            <section>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Chunks ({detail.chunks.length})
              </h3>
              <div className="mt-2 space-y-2">
                {detail.chunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        #{chunk.index} · {chunk.chunkType ?? "other"}
                      </span>
                      <span className="text-zinc-400 dark:text-zinc-500">
                        {chunk.embeddingDimension ? `${chunk.embeddingDimension}d` : "no embedding"}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-line text-zinc-600 dark:text-zinc-400">
                      {chunk.text}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Embeddings</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {detail.embeddingsSummary.totalEmbeddings} vectors ·{" "}
                {detail.embeddingsSummary.embeddingModel ?? "—"} ·{" "}
                {detail.embeddingsSummary.dimension ?? "—"} dimensions
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Processing Timeline
              </h3>
              <ul className="mt-2 space-y-2 text-sm">
                {detail.timeline.map((entry, index) => (
                  <li
                    key={index}
                    className="flex items-center justify-between text-zinc-600 dark:text-zinc-400"
                  >
                    <span>
                      {entry.status} {entry.modelName ? `(${entry.modelName})` : ""}
                      {entry.lastError ? ` — ${entry.lastError}` : ""}
                    </span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {detail.invoice && (
              <section>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Extracted JSON
                </h3>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                  {JSON.stringify(detail.invoice.extractedData, null, 2)}
                </pre>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
