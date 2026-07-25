"use client";

import { useEffect, useState } from "react";
import { StatCard } from "@/components/StatCard";

interface DashboardStats {
  totalDocuments: number;
  totalInvoices: number;
  totalChunks: number;
  totalEmbeddings: number;
  averageChunksPerDocument: number;
  processingSuccessCount: number;
  failedProcessingCount: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/dashboard/stats");
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error ?? "Failed to load dashboard stats");
        }
        if (!cancelled) setStats(data.stats);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard stats");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStats();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Dashboard</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Overview of indexed invoices and processing health.
      </p>

      {loading && (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className="h-24 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800"
            />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          Failed to load dashboard stats: {error}
        </div>
      )}

      {!loading && !error && stats && (
        <>
          {stats.totalDocuments === 0 && (
            <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              No documents indexed yet. Ingest an invoice to see stats here.
            </div>
          )}

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Documents" value={stats.totalDocuments} />
            <StatCard label="Total Invoices" value={stats.totalInvoices} />
            <StatCard label="Total Chunks" value={stats.totalChunks} />
            <StatCard label="Total Embeddings" value={stats.totalEmbeddings} />
            <StatCard
              label="Avg Chunks / Document"
              value={stats.averageChunksPerDocument.toFixed(1)}
            />
            <StatCard
              label="Processing Success"
              value={stats.processingSuccessCount}
              accent="success"
            />
            <StatCard
              label="Failed Processing"
              value={stats.failedProcessingCount}
              accent="danger"
            />
          </div>
        </>
      )}
    </div>
  );
}
