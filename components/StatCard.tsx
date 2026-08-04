interface StatCardProps {
  label: string;
  value: string | number;
  accent?: "default" | "success" | "danger" | "warning";
  footnote?: string;
}

const ACCENT_CLASSES: Record<NonNullable<StatCardProps["accent"]>, string> = {
  default: "text-zinc-900 dark:text-zinc-50",
  success: "text-emerald-600 dark:text-emerald-400",
  danger: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
};

export function StatCard({ label, value, accent = "default", footnote }: StatCardProps) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-2 text-3xl font-semibold ${ACCENT_CLASSES[accent]}`}>{value}</p>
      {footnote && <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{footnote}</p>}
    </div>
  );
}
