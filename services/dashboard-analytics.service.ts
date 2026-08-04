import type { DashboardInvoiceRow } from "@/repositories/processing.repository";
import { summarizeByCurrency } from "@/utils/currency-aggregate";

export type { DashboardInvoiceRow };

export interface MonthlyTrendPoint {
  label: string;
  amount: number;
  currency: string | null;
  excludedCount: number;
}

function monthKeyUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Pure and exported for direct unit testing -- `now` is a parameter (not read from the
// system clock internally) so tests are deterministic regardless of when they run.
export function buildMonthlyTrend(rows: DashboardInvoiceRow[], months: number, now: Date): MonthlyTrendPoint[] {
  const keys: string[] = [];
  const buckets = new Map<string, Array<{ currency: string | null; amount: number }>>();

  for (let i = months - 1; i >= 0; i -= 1) {
    const bucketDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKeyUTC(bucketDate);
    keys.push(key);
    buckets.set(key, []);
  }

  for (const row of rows) {
    if (!row.invoiceDate || row.totalAmount == null) continue;
    const bucket = buckets.get(monthKeyUTC(row.invoiceDate));
    if (!bucket) continue;
    bucket.push({ currency: row.currency, amount: row.totalAmount });
  }

  return keys.map((key) => {
    const summary = summarizeByCurrency(buckets.get(key)!);
    return { label: monthLabel(key), amount: summary.amount, currency: summary.currency, excludedCount: summary.excludedCount };
  });
}

export interface VendorComparisonEntry {
  vendorName: string;
  amount: number;
  currency: string | null;
  excludedCount: number;
}

export function buildVendorComparison(rows: DashboardInvoiceRow[], topN: number): VendorComparisonEntry[] {
  const byVendor = new Map<string, Array<{ currency: string | null; amount: number }>>();

  for (const row of rows) {
    if (!row.vendorName || row.totalAmount == null) continue;
    const list = byVendor.get(row.vendorName) ?? [];
    list.push({ currency: row.currency, amount: row.totalAmount });
    byVendor.set(row.vendorName, list);
  }

  const entries = [...byVendor.entries()].map(([vendorName, amountRows]) => {
    const summary = summarizeByCurrency(amountRows);
    return { vendorName, amount: summary.amount, currency: summary.currency, excludedCount: summary.excludedCount };
  });

  return entries.sort((a, b) => b.amount - a.amount).slice(0, topN);
}

export interface ChargeDistribution {
  subtotal: number;
  tax: number;
  discount: number;
  shipping: number;
  currency: string | null;
  excludedCount: number;
}

export function buildChargeDistribution(rows: DashboardInvoiceRow[]): ChargeDistribution {
  const amountRows = rows.filter((row) => row.totalAmount != null).map((row) => ({ currency: row.currency, amount: row.totalAmount as number }));
  const summary = summarizeByCurrency(amountRows);

  const included = rows.filter((row) => row.totalAmount != null && (row.currency ?? null) === summary.currency);

  const totals = included.reduce(
    (acc, row) => ({
      subtotal: acc.subtotal + (row.subtotal ?? 0),
      tax: acc.tax + (row.taxAmount ?? 0),
      discount: acc.discount + (row.discount ?? 0),
      shipping: acc.shipping + (row.shippingCharge ?? 0),
    }),
    { subtotal: 0, tax: 0, discount: 0, shipping: 0 }
  );

  return { ...totals, currency: summary.currency, excludedCount: summary.excludedCount };
}

export interface LineItemGroupResult {
  description: string;
  amount: number;
  currency: string | null;
  invoiceCount: number;
  excludedCount: number;
}

const MIN_RECURRING_INVOICE_COUNT = 2;

function normalizeDescription(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

interface LineItemAccumulator {
  displayDescription: string;
  rows: Array<{ currency: string | null; amount: number }>;
  invoiceIds: Set<string>;
}

function buildLineItemGroups(rows: DashboardInvoiceRow[]): LineItemGroupResult[] {
  const groups = new Map<string, LineItemAccumulator>();

  for (const row of rows) {
    for (const item of row.lineItems) {
      const key = normalizeDescription(item.description);
      if (!key) continue;

      const group = groups.get(key) ?? { displayDescription: item.description.trim(), rows: [], invoiceIds: new Set<string>() };
      group.rows.push({ currency: row.currency, amount: item.amount });
      group.invoiceIds.add(row.invoiceId);
      groups.set(key, group);
    }
  }

  return [...groups.values()].map((group) => {
    const summary = summarizeByCurrency(group.rows);
    return {
      description: group.displayDescription,
      amount: summary.amount,
      currency: summary.currency,
      invoiceCount: group.invoiceIds.size,
      excludedCount: summary.excludedCount,
    };
  });
}

export function buildServiceCostAnalysis(rows: DashboardInvoiceRow[], topN: number): LineItemGroupResult[] {
  return buildLineItemGroups(rows)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);
}

export function buildTopRecurringExpenses(rows: DashboardInvoiceRow[], topN: number): LineItemGroupResult[] {
  return buildLineItemGroups(rows)
    .filter((group) => group.invoiceCount >= MIN_RECURRING_INVOICE_COUNT)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);
}
