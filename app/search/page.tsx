"use client";

import { useState, type FormEvent } from "react";
import { SearchFilters, type SearchFiltersValue } from "@/components/search/SearchFilters";
import { SearchResultCard, type SearchResultItem } from "@/components/search/SearchResultCard";

const DEFAULT_FILTERS: SearchFiltersValue = {
  topK: 10,
  // Calibrated against measured scores: unrelated queries top out ~0.43, genuinely
  // relevant queries start ~0.52+. See services/search.service.ts for the evidence.
  threshold: 0.45,
  vendorName: "",
  customerName: "",
  invoiceDateFrom: "",
  invoiceDateTo: "",
  chunkType: "",
};

const EXAMPLE_QUERIES = [
  "Find invoices from ABC Technologies",
  "Show invoices containing Industrial Sensors",
  "Find invoices with GST",
  "Invoices from July",
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFiltersValue>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState<SearchResultItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  async function runSearch(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      const activeFilters: Record<string, string> = {};
      if (filters.vendorName) activeFilters.vendorName = filters.vendorName;
      if (filters.customerName) activeFilters.customerName = filters.customerName;
      if (filters.invoiceDateFrom) activeFilters.invoiceDateFrom = filters.invoiceDateFrom;
      if (filters.invoiceDateTo) activeFilters.invoiceDateTo = filters.invoiceDateTo;
      if (filters.chunkType) activeFilters.chunkType = filters.chunkType;

      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          topK: filters.topK,
          threshold: filters.threshold,
          ...(Object.keys(activeFilters).length > 0 ? { filters: activeFilters } : {}),
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error ?? "Search failed");
      }

      setResults(data.results);
      setLastQuery(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Semantic Search</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Ask a natural-language question about your indexed invoices.
      </p>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
        Finds invoices by meaning, not exact words — powered by AI embeddings, not keyword search.
      </p>

      <form onSubmit={runSearch} className="mt-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "Find invoices with GST"'
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="rounded-lg bg-zinc-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!lastQuery &&
            EXAMPLE_QUERIES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuery(example)}
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {example}
              </button>
            ))}
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="ml-auto text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            {showFilters ? "Hide filters" : "Show filters"}
          </button>
        </div>

        {showFilters && <SearchFilters value={filters} onChange={setFilters} className="mt-4" />}
      </form>

      <div className="mt-8">
        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && results && results.length === 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            No matching chunks found{lastQuery ? ` for "${lastQuery}"` : ""}. Try lowering the
            similarity threshold or a different query.
          </div>
        )}

        {!loading && !error && results && results.length > 0 && (
          <div className="space-y-3">
            {results.map((result, index) => (
              <SearchResultCard
                key={`${result.chunkId ?? result.invoiceId}-${index}`}
                result={result}
                query={lastQuery ?? ""}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
