"use client";

import { useCallback, useEffect, useState } from "react";
import { DocumentsTable, type DocumentSummaryItem } from "@/components/documents/DocumentsTable";
import { DocumentDetailsDrawer } from "@/components/documents/DocumentDetailsDrawer";

const PAGE_SIZE = 20;

export default function DocumentsPage() {
  const [items, setItems] = useState<DocumentSummaryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewingId, setViewingId] = useState<string | null>(null);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const [processingAnywayId, setProcessingAnywayId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadDocuments = useCallback(async (targetPage: number) => {
    try {
      const response = await fetch(`/api/documents?page=${targetPage}&limit=${PAGE_SIZE}`);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error ?? "Failed to load documents");
      }
      setItems(data.items);
      setTotal(data.total);
      setPage(data.page);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, []);

  // Inline fetch (rather than calling loadDocuments) so the mount effect owns its
  // own cancellation flag directly, per React's documented data-fetching pattern
  // (avoids react-hooks/set-state-in-effect, which flags calling a named function
  // that sets state from inside an effect body).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/documents?page=1&limit=${PAGE_SIZE}`);
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error ?? "Failed to load documents");
        }
        if (!cancelled) {
          setItems(data.items);
          setTotal(data.total);
          setPage(data.page);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load documents");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function goToPage(targetPage: number) {
    setLoading(true);
    loadDocuments(targetPage);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function handleReindex(documentId: string) {
    setReindexingId(documentId);
    setActionError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/reindex`, { method: "POST" });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error ?? "Reindex failed");
      }
      goToPage(page);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Reindex failed");
    } finally {
      setReindexingId(null);
    }
  }

  async function handleProcessAnyway(documentId: string) {
    setProcessingAnywayId(documentId);
    setActionError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/process-anyway`, { method: "POST" });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error ?? "Failed to process document");
      }
      goToPage(page);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to process document");
    } finally {
      setProcessingAnywayId(null);
    }
  }

  async function performDelete(documentId: string) {
    setDeletingId(documentId);
    setActionError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error ?? "Delete failed");
      }

      const remainingOnPage = items.length - 1;
      const nextPage = remainingOnPage === 0 && page > 1 ? page - 1 : page;
      goToPage(nextPage);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  function handleDeleteClick(documentId: string) {
    if (confirmingDeleteId === documentId) {
      void performDelete(documentId);
    } else {
      setConfirmingDeleteId(documentId);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Documents</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        All indexed invoice documents.
      </p>

      {actionError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {actionError}
        </div>
      )}

      <div className="mt-6">
        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            No documents indexed yet.
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <>
            <DocumentsTable
              items={items}
              onView={setViewingId}
              onReindex={handleReindex}
              onProcessAnyway={handleProcessAnyway}
              onDeleteClick={handleDeleteClick}
              onCancelDelete={() => setConfirmingDeleteId(null)}
              reindexingId={reindexingId}
              processingAnywayId={processingAnywayId}
              confirmingDeleteId={confirmingDeleteId}
              deletingId={deletingId}
            />

            <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
              <span>
                Page {page} of {totalPages} ({total} total)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <DocumentDetailsDrawer
        key={viewingId ?? "closed"}
        documentId={viewingId}
        onClose={() => setViewingId(null)}
      />
    </div>
  );
}
