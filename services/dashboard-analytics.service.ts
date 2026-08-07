import { ProcessingRepository, type DashboardInvoiceRow } from "@/repositories/processing.repository";
import { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";
import { summarizeByCurrency } from "@/utils/currency-aggregate";
import { normalizeCurrency } from "@/utils/currency-normalize";

export type { DashboardInvoiceRow };

const DEFAULT_TREND_MONTHS = 12;
const DEFAULT_VENDOR_TOP_N = 8;
const DEFAULT_SERVICE_TOP_N = 8;
const DEFAULT_RECURRING_TOP_N = 5;
// Matches the "due within N days" window PaymentsDueList shows below the KPI strip --
// keeping these in sync means the KPI count and the list right under it agree, instead
// of the KPI historically counting a 30-day window while the list counted 7.
const DUE_SOON_WINDOW_DAYS = 10;

export interface MonthlyTrendPoint {
  label: string;
  paid: number;
  unpaid: number;
}

// One series per currency actually present, rather than picking a single "dominant"
// currency per month (the old approach) -- that silently mixed units across the x-axis,
// since January's dominant currency and February's dominant currency could differ with
// no label anywhere saying so. A bar chart's bars must all be the same unit to be
// comparable at all; splitting by currency is the fix, not a display tweak on top of the
// old shape.
export interface MonthlyTrendSeries {
  currency: string;
  points: MonthlyTrendPoint[];
}

const UNSPECIFIED_CURRENCY = "Unspecified";

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
export function buildMonthlyTrend(rows: DashboardInvoiceRow[], months: number, now: Date): MonthlyTrendSeries[] {
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    keys.push(monthKeyUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  const keySet = new Set(keys);

  const byCurrency = new Map<string, Map<string, { paid: number; unpaid: number }>>();

  for (const row of rows) {
    if (!row.invoiceDate || row.totalAmount == null) continue;
    const key = monthKeyUTC(row.invoiceDate);
    if (!keySet.has(key)) continue;

    const currency = normalizeCurrency(row.currency) ?? UNSPECIFIED_CURRENCY;
    const monthAmounts = byCurrency.get(currency) ?? new Map<string, { paid: number; unpaid: number }>();
    const bucket = monthAmounts.get(key) ?? { paid: 0, unpaid: 0 };
    if (row.paymentStatus === "PAID") {
      bucket.paid += row.totalAmount;
    } else {
      bucket.unpaid += row.totalAmount;
    }
    monthAmounts.set(key, bucket);
    byCurrency.set(currency, monthAmounts);
  }

  return [...byCurrency.entries()]
    .map(([currency, monthAmounts]) => ({
      currency,
      total: keys.reduce((sum, key) => {
        const bucket = monthAmounts.get(key);
        return sum + (bucket ? bucket.paid + bucket.unpaid : 0);
      }, 0),
      points: keys.map((key) => {
        const bucket = monthAmounts.get(key) ?? { paid: 0, unpaid: 0 };
        return { label: monthLabel(key), paid: bucket.paid, unpaid: bucket.unpaid };
      }),
    }))
    .sort((a, b) => b.total - a.total)
    .map(({ currency, points }) => ({ currency, points }));
}

export interface VendorComparisonEntry {
  vendorName: string;
  paid: number;
  unpaid: number;
  currency: string | null;
  excludedCount: number;
}

export function buildVendorComparison(rows: DashboardInvoiceRow[], topN: number): VendorComparisonEntry[] {
  const byVendor = new Map<string, DashboardInvoiceRow[]>();

  for (const row of rows) {
    if (!row.vendorName || row.totalAmount == null) continue;
    const list = byVendor.get(row.vendorName) ?? [];
    list.push(row);
    byVendor.set(row.vendorName, list);
  }

  const entries = [...byVendor.entries()].map(([vendorName, vendorRows]) => {
    const summary = summarizeByCurrency(vendorRows.map((r) => ({ currency: r.currency, amount: r.totalAmount as number })));

    let paid = 0;
    let unpaid = 0;
    for (const r of vendorRows) {
      if (normalizeCurrency(r.currency) !== summary.currency) continue;
      if (r.paymentStatus === "PAID") paid += r.totalAmount as number;
      else unpaid += r.totalAmount as number;
    }

    return { vendorName, paid, unpaid, currency: summary.currency, excludedCount: summary.excludedCount };
  });

  return entries.sort((a, b) => b.paid + b.unpaid - (a.paid + a.unpaid)).slice(0, topN);
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

  const included = rows.filter((row) => row.totalAmount != null && normalizeCurrency(row.currency) === summary.currency);

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

// Counts, not summed amounts -- a single dollar figure across invoices billed in
// different currencies would either mix units silently or need the same
// dominant-currency-plus-excluded-count caveat summarizeByCurrency already applies
// elsewhere on this dashboard. A count has no currency to get wrong.
export interface KpiSummary {
  totalInvoices: number;
  overdueCount: number;
  dueSoonCount: number;
}

export interface DashboardBusinessData {
  kpi: KpiSummary;
  monthlyTrend: MonthlyTrendSeries[];
  vendorComparison: VendorComparisonEntry[];
  chargeDistribution: ChargeDistribution;
  serviceCostAnalysis: LineItemGroupResult[];
  topRecurringExpenses: LineItemGroupResult[];
}

export class DashboardAnalyticsService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly invoiceStatusQueryService: InvoiceStatusQueryService = new InvoiceStatusQueryService()
  ) {}

  async getBusinessDashboardData(now: Date = new Date()): Promise<DashboardBusinessData> {
    const [rows, overdueInvoices, dueSoonInvoices] = await Promise.all([
      this.repository.listInvoicesForDashboard(),
      this.invoiceStatusQueryService.listByStatus("OVERDUE"),
      this.invoiceStatusQueryService.listByStatus("UPCOMING", DUE_SOON_WINDOW_DAYS),
    ]);

    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const totalInvoices = rows.filter((row) => row.invoiceDate && row.invoiceDate >= startOfYear).length;

    return {
      kpi: {
        totalInvoices,
        overdueCount: overdueInvoices.length,
        dueSoonCount: dueSoonInvoices.length,
      },
      monthlyTrend: buildMonthlyTrend(rows, DEFAULT_TREND_MONTHS, now),
      vendorComparison: buildVendorComparison(rows, DEFAULT_VENDOR_TOP_N),
      chargeDistribution: buildChargeDistribution(rows),
      serviceCostAnalysis: buildServiceCostAnalysis(rows, DEFAULT_SERVICE_TOP_N),
      topRecurringExpenses: buildTopRecurringExpenses(rows, DEFAULT_RECURRING_TOP_N),
    };
  }
}
