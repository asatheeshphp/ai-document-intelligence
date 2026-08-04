import { StatCard } from "@/components/StatCard";
import type { KpiSummary } from "@/services/dashboard-analytics.service";

function formatCurrencyAmount(amount: number, currency: string | null): string {
  const formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${formatted}` : formatted;
}

function excludedFootnote(excludedCount: number): string | undefined {
  if (excludedCount === 0) return undefined;
  return `+${excludedCount} invoice${excludedCount === 1 ? "" : "s"} in other currencies not included`;
}

export function KpiStrip({ kpi }: { kpi: KpiSummary }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Total Spend (YTD)"
        value={formatCurrencyAmount(kpi.totalSpend.amount, kpi.totalSpend.currency)}
        footnote={excludedFootnote(kpi.totalSpend.excludedCount)}
      />
      <StatCard
        label="Avg Invoice Value"
        value={formatCurrencyAmount(kpi.avgInvoiceValue.amount, kpi.avgInvoiceValue.currency)}
        footnote={excludedFootnote(kpi.avgInvoiceValue.excludedCount)}
      />
      <StatCard
        label="Overdue"
        value={formatCurrencyAmount(kpi.overdueAmount.amount, kpi.overdueAmount.currency)}
        accent="danger"
        footnote={excludedFootnote(kpi.overdueAmount.excludedCount)}
      />
      <StatCard
        label="Due in 30 Days"
        value={formatCurrencyAmount(kpi.dueSoonAmount.amount, kpi.dueSoonAmount.currency)}
        accent="warning"
        footnote={excludedFootnote(kpi.dueSoonAmount.excludedCount)}
      />
    </div>
  );
}
