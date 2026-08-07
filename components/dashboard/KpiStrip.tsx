import { StatCard } from "@/components/StatCard";
import type { KpiSummary } from "@/services/dashboard-analytics.service";

export function KpiStrip({ kpi }: { kpi: KpiSummary }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard label="Total Invoices (YTD)" value={kpi.totalInvoices} />
      <StatCard label="Overdue" value={kpi.overdueCount} accent="danger" />
      <StatCard label="Due in 10 Days" value={kpi.dueSoonCount} accent="warning" />
    </div>
  );
}
