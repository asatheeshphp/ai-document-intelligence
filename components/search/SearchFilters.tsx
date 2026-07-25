export interface SearchFiltersValue {
  topK: number;
  threshold: number;
  vendorName: string;
  customerName: string;
  invoiceDateFrom: string;
  invoiceDateTo: string;
  chunkType: string;
}

interface SearchFiltersProps {
  value: SearchFiltersValue;
  onChange: (value: SearchFiltersValue) => void;
  className?: string;
}

const CHUNK_TYPES = ["", "header", "supplier", "customer", "line_items", "taxes", "payment", "notes"];

export function SearchFilters({ value, onChange, className = "" }: SearchFiltersProps) {
  function update<K extends keyof SearchFiltersValue>(key: K, val: SearchFiltersValue[K]) {
    onChange({ ...value, [key]: val });
  }

  return (
    <div
      className={`grid grid-cols-2 gap-4 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Top K
        <input
          type="number"
          min={1}
          max={50}
          value={value.topK}
          onChange={(e) => update("topK", Number(e.target.value) || 10)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Similarity threshold
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={value.threshold}
          onChange={(e) => update("threshold", Number(e.target.value) || 0)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Chunk type
        <select
          value={value.chunkType}
          onChange={(e) => update("chunkType", e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        >
          {CHUNK_TYPES.map((type) => (
            <option key={type} value={type}>
              {type === "" ? "Any" : type}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Supplier
        <input
          type="text"
          value={value.vendorName}
          onChange={(e) => update("vendorName", e.target.value)}
          placeholder="e.g. ABC Technologies"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Customer
        <input
          type="text"
          value={value.customerName}
          onChange={(e) => update("customerName", e.target.value)}
          placeholder="e.g. XYZ Manufacturing"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Invoice date from
        <input
          type="date"
          value={value.invoiceDateFrom}
          onChange={(e) => update("invoiceDateFrom", e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Invoice date to
        <input
          type="date"
          value={value.invoiceDateTo}
          onChange={(e) => update("invoiceDateTo", e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        />
      </label>
    </div>
  );
}
