const STATUS_STYLES: Record<string, string> = {
  EXTRACTED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  EXTRACTING: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  PENDING: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  DOWNLOADED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  OCR_REQUIRED: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  OCR_COMPLETE: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  FAILED: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  DUPLICATE_REVIEW: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-400",
};

export function StatusBadge({ status }: { status: string }) {
  const style =
    STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}
