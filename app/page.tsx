"use client";

import { useEffect, useState } from "react";
import { KpiStrip } from "@/components/dashboard/KpiStrip";
import { MonthlySpendTrendChart } from "@/components/dashboard/MonthlySpendTrendChart";
import { VendorComparisonChart } from "@/components/dashboard/VendorComparisonChart";
import { ChargeDistributionChart } from "@/components/dashboard/ChargeDistributionChart";
import { ServiceCostAnalysisChart } from "@/components/dashboard/ServiceCostAnalysisChart";
import { TopRecurringExpensesList } from "@/components/dashboard/TopRecurringExpensesList";
import { PaymentsDueList } from "@/components/PaymentsDueList";
import type { DashboardBusinessData } from "@/services/dashboard-analytics.service";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardBusinessData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/dashboard/business");
        const json = await response.json();
        if (!json.success) {
          throw new Error(json.error ?? "Failed to load dashboard data");
        }
        if (!cancelled) setData(json.data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Dashboard</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Spending overview computed from your indexed invoices.
      </p>

      {loading && (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          Failed to load dashboard data: {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="mt-8">
            <KpiStrip kpi={data.kpi} />
          </div>

          <div className="mt-8">
            <MonthlySpendTrendChart data={data.monthlyTrend} />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <VendorComparisonChart data={data.vendorComparison} />
            <ChargeDistributionChart data={data.chargeDistribution} />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopRecurringExpensesList data={data.topRecurringExpenses} />
            <ServiceCostAnalysisChart data={data.serviceCostAnalysis} />
          </div>

          <PaymentsDueList />
        </>
      )}
    </div>
  );
}
