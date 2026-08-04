# Business Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pipeline-health dashboard (`app/page.tsx`) with a finance/AP-style dashboard (spend trend, vendor comparison, service cost analysis, top recurring expenses, charge distribution, KPI strip) computed from real invoice data, and refresh the app's visual theme to a warm cream background with a TechGrit-orange accent.

**Architecture:** A new `DashboardAnalyticsService` composes a set of small, pure, independently-testable grouping functions (monthly trend, vendor comparison, charge distribution, line-item grouping) over one new repository method (`ProcessingRepository.listInvoicesForDashboard`) that returns a flat, denormalized row per invoice. A shared `summarizeByCurrency` helper (in `utils/currency-aggregate.ts`) is reused everywhere a widget sums money, so mixed-currency data is flagged consistently instead of silently mixed. One new API route (`/api/dashboard/business`) returns everything the page needs in one payload. The old pipeline-stats UI moves verbatim to a new `/system` page. Recharts renders the bar/donut charts.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Mongoose/MongoDB, Vitest, Tailwind CSS v4, Recharts (new dependency).

**Reference spec:** `docs/superpowers/specs/2026-08-04-business-dashboard-design.md`

---

## Task 1: Add Recharts dependency

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install the package**

Run: `npm install recharts`
Expected: `package.json` and `package-lock.json` gain a `recharts` entry; command exits 0.

- [ ] **Step 2: Verify it resolves**

Run: `node -e "console.log(require('recharts/package.json').version)"`
Expected: prints a version number (e.g. `2.x.x`), no error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add recharts for dashboard charts"
```

---

## Task 2: Currency aggregation helper

**Files:**
- Create: `utils/currency-aggregate.ts`
- Test: `utils/currency-aggregate.test.ts`

Every widget that sums money across invoices needs the same rule: if the rows span more
than one currency, only sum the dominant one (the currency backed by the most
contributing rows) and report how many rows got excluded — never silently add
incompatible units. This is the same principle `formatSpendAnswer` in
`services/rag.service.ts` already uses for chat answers, generalized into one reusable
pure function so six different widgets don't reimplement it six times.

- [ ] **Step 1: Write the failing tests**

Create `utils/currency-aggregate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { summarizeByCurrency } from "@/utils/currency-aggregate";

describe("summarizeByCurrency", () => {
  it("sums all rows when every row shares one currency", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "INR", amount: 250 },
    ]);

    expect(result).toEqual({ amount: 350, currency: "INR", includedCount: 2, excludedCount: 0 });
  });

  it("picks the currency with the most contributing rows as dominant", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "INR", amount: 200 },
      { currency: "USD", amount: 5000 },
    ]);

    expect(result.currency).toBe("INR");
    expect(result.amount).toBe(300);
    expect(result.includedCount).toBe(2);
    expect(result.excludedCount).toBe(1);
  });

  it("breaks a row-count tie by picking the larger total", () => {
    const result = summarizeByCurrency([
      { currency: "INR", amount: 100 },
      { currency: "USD", amount: 5000 },
    ]);

    expect(result.currency).toBe("USD");
    expect(result.amount).toBe(5000);
  });

  it("treats a null currency as its own group", () => {
    const result = summarizeByCurrency([
      { currency: null, amount: 10 },
      { currency: null, amount: 20 },
      { currency: "INR", amount: 999 },
    ]);

    expect(result.currency).toBeNull();
    expect(result.amount).toBe(30);
    expect(result.excludedCount).toBe(1);
  });

  it("returns a zeroed-out summary for an empty row list", () => {
    const result = summarizeByCurrency([]);

    expect(result).toEqual({ amount: 0, currency: null, includedCount: 0, excludedCount: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run utils/currency-aggregate.test.ts`
Expected: FAIL — `Cannot find module '@/utils/currency-aggregate'`.

- [ ] **Step 3: Write the implementation**

Create `utils/currency-aggregate.ts`:

```typescript
export interface CurrencyAmountRow {
  currency: string | null;
  amount: number;
}

export interface CurrencySummary {
  amount: number;
  currency: string | null;
  includedCount: number;
  excludedCount: number;
}

// Picks the currency backed by the most contributing rows as "dominant" (ties broken by
// whichever has the larger summed amount) and sums only that currency's rows -- the same
// "flag, don't silently mix units" principle formatSpendAnswer already established in
// rag.service.ts, generalized into one reusable helper so every dashboard widget applies
// the same rule instead of six bespoke copies of it.
export function summarizeByCurrency(rows: CurrencyAmountRow[]): CurrencySummary {
  const groups = new Map<string, { total: number; count: number }>();

  for (const row of rows) {
    const key = row.currency ?? "";
    const group = groups.get(key) ?? { total: 0, count: 0 };
    group.total += row.amount;
    group.count += 1;
    groups.set(key, group);
  }

  if (groups.size === 0) {
    return { amount: 0, currency: null, includedCount: 0, excludedCount: 0 };
  }

  let dominantKey = "";
  let dominant = { total: 0, count: -1 };

  for (const [key, group] of groups) {
    if (group.count > dominant.count || (group.count === dominant.count && group.total > dominant.total)) {
      dominantKey = key;
      dominant = group;
    }
  }

  return {
    amount: dominant.total,
    currency: dominantKey || null,
    includedCount: dominant.count,
    excludedCount: rows.length - dominant.count,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run utils/currency-aggregate.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add utils/currency-aggregate.ts utils/currency-aggregate.test.ts
git commit -m "feat: add shared currency-summarizing helper for dashboard widgets"
```

---

## Task 3: Repository method for dashboard data

**Files:**
- Modify: `repositories/processing.repository.ts`

Adds one new method that returns a flat, denormalized row per invoice (vendor, currency,
totals, and its own line items) — everything every dashboard widget needs, fetched once.
No new repository test is added here: this codebase has no DB-backed repository tests
today (every existing test mocks at the service layer with a fake repository — see
`services/line-item-aggregation.service.test.ts`), so this method is exercised
indirectly via `DashboardAnalyticsService`'s tests in Task 5, consistent with that
existing convention.

- [ ] **Step 1: Add the new types and method**

In `repositories/processing.repository.ts`, add near the top (after the existing
`CreateInvoiceInput` interface):

```typescript
export interface DashboardLineItemRow {
  description: string;
  amount: number;
}

export interface DashboardInvoiceRow {
  invoiceId: string;
  vendorName: string | null;
  currency: string | null;
  totalAmount: number | null;
  subtotal: number | null;
  taxAmount: number | null;
  discount: number | null;
  shippingCharge: number | null;
  invoiceDate: Date | null;
  lineItems: DashboardLineItemRow[];
}
```

Then add this method to the `ProcessingRepository` class, directly after `listInvoices`:

```typescript
  // Returns one flat row per invoice with everything the business dashboard's widgets
  // need (vendor, currency, totals, and its own line items) -- fetched once so
  // DashboardAnalyticsService's pure grouping functions (monthly trend, vendor
  // comparison, charge distribution, line-item grouping) can all run in plain
  // TypeScript against the same in-memory dataset, rather than six separate Mongo
  // aggregation pipelines.
  async listInvoicesForDashboard(): Promise<DashboardInvoiceRow[]> {
    return this.withConnection(async () => {
      const invoices = await Invoice.find({}).exec();

      return invoices.map((invoice) => {
        const extractedData = invoice.extractedData as
          | { totals?: { discount?: number | null; shippingCharge?: number | null }; lineItems?: Array<{ description?: string | null; amount?: number | null }> }
          | undefined;

        const lineItems = (extractedData?.lineItems ?? [])
          .filter((item): item is { description: string; amount: number } => Boolean(item?.description) && typeof item?.amount === "number")
          .map((item) => ({ description: item.description, amount: item.amount }));

        return {
          invoiceId: invoice._id.toString(),
          vendorName: invoice.vendorName ?? null,
          currency: invoice.currency ?? null,
          totalAmount: invoice.totalAmount ?? null,
          subtotal: invoice.subtotal ?? null,
          taxAmount: invoice.taxAmount ?? null,
          discount: extractedData?.totals?.discount ?? null,
          shippingCharge: extractedData?.totals?.shippingCharge ?? null,
          invoiceDate: invoice.invoiceDate ?? null,
          lineItems,
        };
      });
    });
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add repositories/processing.repository.ts
git commit -m "feat: add listInvoicesForDashboard repository method"
```

---

## Task 4: Pure grouping functions for each widget

**Files:**
- Create: `services/dashboard-analytics.service.ts`
- Test: `services/dashboard-analytics.service.test.ts`

Each function below is pure (plain data in, plain data out, no DB access), so this task
is pure TDD — no mocking needed. `DashboardAnalyticsService` itself (the class that
wires these to the repository) is added in Task 5.

- [ ] **Step 1: Write the failing tests for `buildMonthlyTrend`**

Create `services/dashboard-analytics.service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildMonthlyTrend,
  buildVendorComparison,
  buildChargeDistribution,
  buildServiceCostAnalysis,
  buildTopRecurringExpenses,
  type DashboardInvoiceRow,
} from "@/services/dashboard-analytics.service";

function row(overrides: Partial<DashboardInvoiceRow> = {}): DashboardInvoiceRow {
  return {
    invoiceId: "inv-1",
    vendorName: "Vendor Co",
    currency: "INR",
    totalAmount: 100,
    subtotal: 90,
    taxAmount: 10,
    discount: 0,
    shippingCharge: 0,
    invoiceDate: new Date("2026-06-15T00:00:00Z"),
    lineItems: [],
    ...overrides,
  };
}

describe("buildMonthlyTrend", () => {
  it("sums totalAmount per calendar month within the trailing window", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: new Date("2026-06-01T00:00:00Z"), totalAmount: 100 }),
      row({ invoiceDate: new Date("2026-06-20T00:00:00Z"), totalAmount: 50 }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: 200 }),
    ];

    const result = buildMonthlyTrend(rows, 2, now);

    expect(result).toEqual([
      { label: "Jun 2026", amount: 150, currency: "INR", excludedCount: 0 },
      { label: "Jul 2026", amount: 200, currency: "INR", excludedCount: 0 },
    ]);
  });

  it("includes a zero-amount point for a month with no invoices", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const result = buildMonthlyTrend([], 2, now);

    expect(result).toEqual([
      { label: "Jun 2026", amount: 0, currency: null, excludedCount: 0 },
      { label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 },
    ]);
  });

  it("excludes invoices with no date or no amount", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [
      row({ invoiceDate: null, totalAmount: 999 }),
      row({ invoiceDate: new Date("2026-07-01T00:00:00Z"), totalAmount: null }),
    ];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([{ label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 }]);
  });

  it("ignores invoices outside the trailing window", () => {
    const now = new Date("2026-07-15T00:00:00Z");
    const rows = [row({ invoiceDate: new Date("2025-01-01T00:00:00Z"), totalAmount: 500 })];

    const result = buildMonthlyTrend(rows, 1, now);

    expect(result).toEqual([{ label: "Jul 2026", amount: 0, currency: null, excludedCount: 0 }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/dashboard-analytics.service'`.

- [ ] **Step 3: Implement `buildMonthlyTrend`**

Create `services/dashboard-analytics.service.ts`:

```typescript
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing tests for `buildVendorComparison`**

Add to `services/dashboard-analytics.service.test.ts` (after the `buildMonthlyTrend`
`describe` block):

```typescript
describe("buildVendorComparison", () => {
  it("sums totalAmount per vendor and sorts descending", () => {
    const rows = [
      row({ vendorName: "Vendor A", totalAmount: 100 }),
      row({ vendorName: "Vendor B", totalAmount: 500 }),
      row({ vendorName: "Vendor A", totalAmount: 50 }),
    ];

    const result = buildVendorComparison(rows, 8);

    expect(result).toEqual([
      { vendorName: "Vendor B", amount: 500, currency: "INR", excludedCount: 0 },
      { vendorName: "Vendor A", amount: 150, currency: "INR", excludedCount: 0 },
    ]);
  });

  it("caps results to topN", () => {
    const rows = [
      row({ vendorName: "A", totalAmount: 300 }),
      row({ vendorName: "B", totalAmount: 200 }),
      row({ vendorName: "C", totalAmount: 100 }),
    ];

    const result = buildVendorComparison(rows, 2);

    expect(result.map((entry) => entry.vendorName)).toEqual(["A", "B"]);
  });

  it("skips invoices with no vendor name or no amount", () => {
    const rows = [row({ vendorName: null, totalAmount: 999 }), row({ vendorName: "A", totalAmount: null })];

    const result = buildVendorComparison(rows, 8);

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: FAIL — `buildVendorComparison is not a function` (or "does not provide an export").

- [ ] **Step 7: Implement `buildVendorComparison`**

Add to `services/dashboard-analytics.service.ts`:

```typescript
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
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: PASS — 7 tests total so far.

- [ ] **Step 9: Write the failing tests for `buildChargeDistribution`**

Add to the test file:

```typescript
describe("buildChargeDistribution", () => {
  it("sums subtotal, tax, discount, and shipping across invoices in the dominant currency", () => {
    const rows = [
      row({ currency: "INR", subtotal: 100, taxAmount: 10, discount: 5, shippingCharge: 2 }),
      row({ currency: "INR", subtotal: 200, taxAmount: 20, discount: 0, shippingCharge: 8 }),
    ];

    const result = buildChargeDistribution(rows);

    expect(result).toEqual({ subtotal: 300, tax: 30, discount: 5, shipping: 10, currency: "INR", excludedCount: 0 });
  });

  it("excludes invoices in a non-dominant currency from the totals", () => {
    const rows = [
      row({ currency: "INR", totalAmount: 100, subtotal: 90, taxAmount: 10 }),
      row({ currency: "INR", totalAmount: 200, subtotal: 180, taxAmount: 20 }),
      row({ currency: "USD", totalAmount: 5000, subtotal: 4500, taxAmount: 500 }),
    ];

    const result = buildChargeDistribution(rows);

    expect(result.currency).toBe("INR");
    expect(result.subtotal).toBe(270);
    expect(result.excludedCount).toBe(1);
  });

  it("treats missing discount/shipping fields as zero", () => {
    const rows = [row({ discount: null, shippingCharge: null })];

    const result = buildChargeDistribution(rows);

    expect(result.discount).toBe(0);
    expect(result.shipping).toBe(0);
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: FAIL — `buildChargeDistribution is not a function`.

- [ ] **Step 11: Implement `buildChargeDistribution`**

Add to `services/dashboard-analytics.service.ts`:

```typescript
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
```

- [ ] **Step 12: Run to verify it passes**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: PASS — 10 tests total so far.

- [ ] **Step 13: Write the failing tests for line-item grouping**

Add to the test file:

```typescript
describe("buildServiceCostAnalysis and buildTopRecurringExpenses", () => {
  it("groups line items by normalized description and sums amounts", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "  internet service  ", amount: 300 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "Office Chair", amount: 1000 }] }),
    ];

    const result = buildServiceCostAnalysis(rows, 8);

    expect(result).toEqual(
      expect.arrayContaining([
        { description: "Office Chair", amount: 1000, currency: "INR", invoiceCount: 1, excludedCount: 0 },
        { description: "Internet Service", amount: 800, currency: "INR", invoiceCount: 2, excludedCount: 0 },
      ])
    );
    expect(result[0].description).toBe("Office Chair");
  });

  it("caps service cost analysis to topN", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "A", amount: 300 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "B", amount: 200 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "C", amount: 100 }] }),
    ];

    const result = buildServiceCostAnalysis(rows, 2);

    expect(result.map((entry) => entry.description)).toEqual(["A", "B"]);
  });

  it("only includes descriptions appearing in 2+ invoices as recurring", () => {
    const rows = [
      row({ invoiceId: "inv-1", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-2", lineItems: [{ description: "Internet Service", amount: 500 }] }),
      row({ invoiceId: "inv-3", lineItems: [{ description: "One-off Repair", amount: 9000 }] }),
    ];

    const result = buildTopRecurringExpenses(rows, 8);

    expect(result).toEqual([{ description: "Internet Service", amount: 1000, currency: "INR", invoiceCount: 2, excludedCount: 0 }]);
  });

  it("counts a description once per invoice even if repeated within the same invoice", () => {
    const rows = [
      row({
        invoiceId: "inv-1",
        lineItems: [
          { description: "Widget", amount: 10 },
          { description: "Widget", amount: 20 },
        ],
      }),
    ];

    const result = buildServiceCostAnalysis(rows, 8);

    expect(result).toEqual([{ description: "Widget", amount: 30, currency: "INR", invoiceCount: 1, excludedCount: 0 }]);
  });
});
```

- [ ] **Step 14: Run to verify it fails**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: FAIL — `buildServiceCostAnalysis is not a function`.

- [ ] **Step 15: Implement line-item grouping**

Add to `services/dashboard-analytics.service.ts`:

```typescript
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
```

- [ ] **Step 16: Run to verify it passes**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: PASS — 14 tests total.

- [ ] **Step 17: Commit**

```bash
git add services/dashboard-analytics.service.ts services/dashboard-analytics.service.test.ts
git commit -m "feat: add pure grouping functions for dashboard widgets"
```

---

## Task 5: DashboardAnalyticsService orchestration

**Files:**
- Modify: `services/dashboard-analytics.service.ts`
- Modify: `services/dashboard-analytics.service.test.ts`

Wires the pure functions from Task 4 to `ProcessingRepository.listInvoicesForDashboard`
and `InvoiceStatusQueryService` (for the KPI strip's overdue/due-soon figures, reusing
that already-tested logic rather than reimplementing it).

- [ ] **Step 1: Write the failing test**

Add to `services/dashboard-analytics.service.test.ts` (add these imports to the top of
the file alongside the existing ones):

```typescript
import { vi } from "vitest";
import { DashboardAnalyticsService } from "@/services/dashboard-analytics.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";
```

Then add this `describe` block:

```typescript
describe("DashboardAnalyticsService.getBusinessDashboardData", () => {
  function fakeRepository(rows: DashboardInvoiceRow[]): ProcessingRepository {
    return { listInvoicesForDashboard: vi.fn().mockResolvedValue(rows) } as unknown as ProcessingRepository;
  }

  function fakeStatusService(overdue: unknown[], dueSoon: unknown[]): InvoiceStatusQueryService {
    return {
      listByStatus: vi.fn().mockImplementation((status: string) => Promise.resolve(status === "OVERDUE" ? overdue : dueSoon)),
    } as unknown as InvoiceStatusQueryService;
  }

  it("computes total spend YTD, average invoice value, and overdue/due-soon KPIs", async () => {
    const now = new Date("2026-07-30T00:00:00Z");
    const rows = [
      row({ invoiceId: "a", invoiceDate: new Date("2026-01-15T00:00:00Z"), totalAmount: 100 }),
      row({ invoiceId: "b", invoiceDate: new Date("2025-12-01T00:00:00Z"), totalAmount: 900 }),
    ];
    const overdue = [{ totalAmount: 50, currency: "INR" }];
    const dueSoon = [{ totalAmount: 75, currency: "INR" }];

    const service = new DashboardAnalyticsService(fakeRepository(rows), fakeStatusService(overdue, dueSoon));
    const result = await service.getBusinessDashboardData(now);

    expect(result.kpi.totalSpend).toEqual({ amount: 100, currency: "INR", excludedCount: 0 });
    expect(result.kpi.avgInvoiceValue).toEqual({ amount: 500, currency: "INR", excludedCount: 0, invoiceCount: 2 });
    expect(result.kpi.overdueAmount).toEqual({ amount: 50, currency: "INR", excludedCount: 0 });
    expect(result.kpi.dueSoonAmount).toEqual({ amount: 75, currency: "INR", excludedCount: 0 });
  });

  it("includes all six widget payloads in the result", async () => {
    const service = new DashboardAnalyticsService(fakeRepository([]), fakeStatusService([], []));
    const result = await service.getBusinessDashboardData(new Date("2026-07-30T00:00:00Z"));

    expect(result).toHaveProperty("kpi");
    expect(result).toHaveProperty("monthlyTrend");
    expect(result).toHaveProperty("vendorComparison");
    expect(result).toHaveProperty("chargeDistribution");
    expect(result).toHaveProperty("serviceCostAnalysis");
    expect(result).toHaveProperty("topRecurringExpenses");
  });

  it("requests OVERDUE and UPCOMING-30-day status filters", async () => {
    const statusService = fakeStatusService([], []);
    const service = new DashboardAnalyticsService(fakeRepository([]), statusService);

    await service.getBusinessDashboardData(new Date("2026-07-30T00:00:00Z"));

    expect(statusService.listByStatus).toHaveBeenCalledWith("OVERDUE");
    expect(statusService.listByStatus).toHaveBeenCalledWith("UPCOMING", 30);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: FAIL — `DashboardAnalyticsService is not a constructor` (or "does not provide an export").

- [ ] **Step 3: Implement `DashboardAnalyticsService`**

Add to `services/dashboard-analytics.service.ts` (imports go at the top alongside the
existing ones):

```typescript
import { ProcessingRepository } from "@/repositories/processing.repository";
import { InvoiceStatusQueryService } from "@/services/invoice-status-query.service";

const DEFAULT_TREND_MONTHS = 12;
const DEFAULT_VENDOR_TOP_N = 8;
const DEFAULT_SERVICE_TOP_N = 8;
const DEFAULT_RECURRING_TOP_N = 5;
```

Add these types and the class at the end of the file:

```typescript
export interface CurrencyAmountSummary {
  amount: number;
  currency: string | null;
  excludedCount: number;
}

export interface KpiSummary {
  totalSpend: CurrencyAmountSummary;
  avgInvoiceValue: CurrencyAmountSummary & { invoiceCount: number };
  overdueAmount: CurrencyAmountSummary;
  dueSoonAmount: CurrencyAmountSummary;
}

export interface DashboardBusinessData {
  kpi: KpiSummary;
  monthlyTrend: MonthlyTrendPoint[];
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
      this.invoiceStatusQueryService.listByStatus("UPCOMING", 30),
    ]);

    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const ytdRows = rows
      .filter((row) => row.invoiceDate && row.invoiceDate >= startOfYear && row.totalAmount != null)
      .map((row) => ({ currency: row.currency, amount: row.totalAmount as number }));
    const totalSpendSummary = summarizeByCurrency(ytdRows);

    const allAmountRows = rows.filter((row) => row.totalAmount != null).map((row) => ({ currency: row.currency, amount: row.totalAmount as number }));
    const avgSummary = summarizeByCurrency(allAmountRows);

    const overdueSummary = summarizeByCurrency(
      overdueInvoices.filter((invoice) => invoice.totalAmount != null).map((invoice) => ({ currency: invoice.currency ?? null, amount: invoice.totalAmount as number }))
    );
    const dueSoonSummary = summarizeByCurrency(
      dueSoonInvoices.filter((invoice) => invoice.totalAmount != null).map((invoice) => ({ currency: invoice.currency ?? null, amount: invoice.totalAmount as number }))
    );

    return {
      kpi: {
        totalSpend: { amount: totalSpendSummary.amount, currency: totalSpendSummary.currency, excludedCount: totalSpendSummary.excludedCount },
        avgInvoiceValue: {
          amount: avgSummary.includedCount > 0 ? avgSummary.amount / avgSummary.includedCount : 0,
          currency: avgSummary.currency,
          excludedCount: avgSummary.excludedCount,
          invoiceCount: avgSummary.includedCount,
        },
        overdueAmount: { amount: overdueSummary.amount, currency: overdueSummary.currency, excludedCount: overdueSummary.excludedCount },
        dueSoonAmount: { amount: dueSoonSummary.amount, currency: dueSoonSummary.currency, excludedCount: dueSoonSummary.excludedCount },
      },
      monthlyTrend: buildMonthlyTrend(rows, DEFAULT_TREND_MONTHS, now),
      vendorComparison: buildVendorComparison(rows, DEFAULT_VENDOR_TOP_N),
      chargeDistribution: buildChargeDistribution(rows),
      serviceCostAnalysis: buildServiceCostAnalysis(rows, DEFAULT_SERVICE_TOP_N),
      topRecurringExpenses: buildTopRecurringExpenses(rows, DEFAULT_RECURRING_TOP_N),
    };
  }
}
```

Note: `InvoiceStatusQueryService.listByStatus` returns items typed with `currency?: string`
(optional, not nullable) — the `invoice.currency ?? null` conversions above are required
for `summarizeByCurrency`'s `string | null` parameter type to typecheck.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run services/dashboard-analytics.service.test.ts`
Expected: PASS — 17 tests total.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add services/dashboard-analytics.service.ts services/dashboard-analytics.service.test.ts
git commit -m "feat: add DashboardAnalyticsService orchestrating all dashboard widgets"
```

---

## Task 6: Business dashboard API route

**Files:**
- Create: `app/api/dashboard/business/route.ts`

Matches the existing `/api/dashboard/stats` route's shape and error handling exactly. No
test file — consistent with this codebase's existing convention of not testing API route
handlers directly (see `app/api/dashboard/stats/route.ts`, `app/api/invoices/due/route.ts`).

- [ ] **Step 1: Create the route**

Create `app/api/dashboard/business/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { DashboardAnalyticsService } from "@/services/dashboard-analytics.service";

export async function GET() {
  try {
    const service = new DashboardAnalyticsService();
    const data = await service.getBusinessDashboardData();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown dashboard business-data error",
      },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/dashboard/business/route.ts
git commit -m "feat: add /api/dashboard/business route"
```

---

## Task 7: Relocate pipeline stats to a secondary page

**Files:**
- Create: `app/system/page.tsx`

Moves the CURRENT `app/page.tsx` contents verbatim to a new route, before Task 16
replaces `app/page.tsx` with the new business dashboard. This keeps the pipeline-health
view available with zero behavior change.

- [ ] **Step 1: Create the system page with the existing dashboard's exact logic**

Create `app/system/page.tsx`:

```typescript
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

export default function SystemPage() {
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
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">System Health</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Overview of indexed invoices and processing health.
      </p>

      {loading && (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
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
            <StatCard label="Avg Chunks / Document" value={stats.averageChunksPerDocument.toFixed(1)} />
            <StatCard label="Processing Success" value={stats.processingSuccessCount} accent="success" />
            <StatCard label="Failed Processing" value={stats.failedProcessingCount} accent="danger" />
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/system/page.tsx
git commit -m "feat: relocate pipeline health stats to /system page"
```

---

## Task 8: Theme groundwork on StatCard

**Files:**
- Modify: `components/StatCard.tsx`

Adds a `warning` accent (amber, for "Due in 30 Days") and an optional `footnote` (for
the mixed-currency notes), and updates the card border to the new cream-theme color.
Both existing usages (`app/system/page.tsx`'s `success`/`danger` accents) keep working
unchanged since these are additive.

- [ ] **Step 1: Update `StatCard.tsx`**

Replace the full contents of `components/StatCard.tsx`:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/StatCard.tsx
git commit -m "feat: add warning accent and footnote to StatCard, retheme border"
```

---

## Task 9: Theme — header, footer, page background

**Files:**
- Modify: `components/Nav.tsx`
- Create: `components/Footer.tsx`
- Modify: `app/layout.tsx`

Applies the approved "Warm Cream + Orange" theme (light mode only — dark mode is
untouched) and adds the app's first-ever footer (a minimal branding strip, no
navigation links, per the earlier decision). The relocated `/system` page gets a small,
muted link in the header instead, separate from the primary nav pills.

Note on implementation mechanism: the spec describes adding CSS custom properties to
`app/globals.css`, but the existing `--background`/`--foreground` vars there are
already dead — `Nav.tsx` and `layout.tsx`'s `<body>` hardcode Tailwind utility classes
(`bg-white`, `bg-zinc-50`, etc.) directly and never reference those vars. This task
applies the new colors the same way the rest of the codebase already does color
(`StatCard`, `PaymentsDueList` use Tailwind zinc/emerald/red classes directly) — via
Tailwind arbitrary-value utility classes in each component — rather than reviving the
unused CSS-variable mechanism. Same visual result, consistent with the codebase's actual
convention.

- [ ] **Step 1: Update `Nav.tsx`**

Replace the full contents of `components/Nav.tsx`:

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/documents", label: "Documents" },
  { href: "/search", label: "Search" },
  { href: "/chat", label: "Chat" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-[#f3e3cf] bg-white dark:border-zinc-800 dark:bg-black">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-gradient-to-br from-[#FF9A2E] to-[#F5720C]" />
          <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            AI Document Intelligence
          </span>
        </div>

        <div className="flex items-center gap-4">
          <nav className="flex gap-1">
            {LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-[#F5720C] text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:bg-[#fff1e6] dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <Link
            href="/system"
            className="text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            System Health
          </Link>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Create `Footer.tsx`**

Create `components/Footer.tsx`:

```typescript
export function Footer() {
  return (
    <footer className="border-t border-[#f3e3cf] bg-white dark:border-zinc-800 dark:bg-black">
      <div className="mx-auto max-w-6xl px-6 py-4 text-xs text-[#b08a5a] dark:text-zinc-500">
        AI Document Intelligence · TechGrit
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Wire the footer and cream background into `layout.tsx`**

In `app/layout.tsx`, add the import:

```typescript
import { Footer } from "@/components/Footer";
```

Then update the `<body>` element:

```typescript
      <body className="min-h-full flex flex-col bg-[#fffaf3] dark:bg-black">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/Nav.tsx components/Footer.tsx app/layout.tsx
git commit -m "feat: apply warm cream + orange theme to header, add footer"
```

---

## Task 10: KpiStrip component

**Files:**
- Create: `components/dashboard/KpiStrip.tsx`

- [ ] **Step 1: Create the component**

Create `components/dashboard/KpiStrip.tsx`:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/KpiStrip.tsx
git commit -m "feat: add KpiStrip dashboard component"
```

---

## Task 11: Monthly Spending Trend chart

**Files:**
- Create: `components/dashboard/MonthlySpendTrendChart.tsx`

- [ ] **Step 1: Create the component**

Create `components/dashboard/MonthlySpendTrendChart.tsx`:

```typescript
"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthlyTrendPoint } from "@/services/dashboard-analytics.service";

const BRAND_ORANGE = "#F5720C";

export function MonthlySpendTrendChart({ data }: { data: MonthlyTrendPoint[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Monthly Spending Trend</h2>
      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
            <YAxis tick={{ fontSize: 12 }} stroke="#a1a1aa" />
            <Tooltip />
            <Bar dataKey="amount" fill={BRAND_ORANGE} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/MonthlySpendTrendChart.tsx
git commit -m "feat: add MonthlySpendTrendChart dashboard component"
```

---

## Task 12: Vendor Comparison chart

**Files:**
- Create: `components/dashboard/VendorComparisonChart.tsx`

- [ ] **Step 1: Create the component**

Create `components/dashboard/VendorComparisonChart.tsx`:

```typescript
"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { VendorComparisonEntry } from "@/services/dashboard-analytics.service";

const BRAND_ORANGE = "#F5720C";

export function VendorComparisonChart({ data }: { data: VendorComparisonEntry[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Vendor Comparison</h2>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No vendor spend data yet.</p>
      ) : (
        <div className="mt-4" style={{ height: Math.max(160, data.length * 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
              <YAxis dataKey="vendorName" type="category" tick={{ fontSize: 12 }} stroke="#a1a1aa" width={140} />
              <Tooltip />
              <Bar dataKey="amount" fill={BRAND_ORANGE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/VendorComparisonChart.tsx
git commit -m "feat: add VendorComparisonChart dashboard component"
```

---

## Task 13: Charge Distribution chart

**Files:**
- Create: `components/dashboard/ChargeDistributionChart.tsx`

Uses distinct hues (orange/indigo/sky/violet) for its four slices — deliberately none of
them the red-orange/amber/emerald already used elsewhere for overdue/due-soon/paid
status, so a donut slice is never visually confused with a payment-status signal.

- [ ] **Step 1: Create the component**

Create `components/dashboard/ChargeDistributionChart.tsx`:

```typescript
"use client";

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { ChargeDistribution } from "@/services/dashboard-analytics.service";

const SLICE_COLORS: Record<string, string> = {
  Subtotal: "#F5720C",
  Tax: "#6366F1",
  Discount: "#38BDF8",
  Shipping: "#A78BFA",
};

export function ChargeDistributionChart({ data }: { data: ChargeDistribution }) {
  const slices = [
    { name: "Subtotal", value: data.subtotal },
    { name: "Tax", value: data.tax },
    { name: "Discount", value: data.discount },
    { name: "Shipping", value: data.shipping },
  ].filter((slice) => slice.value > 0);

  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Charge Distribution</h2>
      {slices.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No charge data yet.</p>
      ) : (
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {slices.map((slice) => (
                  <Cell key={slice.name} fill={SLICE_COLORS[slice.name]} />
                ))}
              </Pie>
              <Legend verticalAlign="bottom" height={24} />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/ChargeDistributionChart.tsx
git commit -m "feat: add ChargeDistributionChart dashboard component"
```

---

## Task 14: Service Cost Analysis chart

**Files:**
- Create: `components/dashboard/ServiceCostAnalysisChart.tsx`

Same shape as `VendorComparisonChart` but a distinct indigo fill, so the two side-by-side
ranked-bar widgets remain visually distinguishable from each other.

- [ ] **Step 1: Create the component**

Create `components/dashboard/ServiceCostAnalysisChart.tsx`:

```typescript
"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LineItemGroupResult } from "@/services/dashboard-analytics.service";

const SERVICE_INDIGO = "#6366F1";

export function ServiceCostAnalysisChart({ data }: { data: LineItemGroupResult[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Service Cost Analysis</h2>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No line-item data yet.</p>
      ) : (
        <div className="mt-4" style={{ height: Math.max(160, data.length * 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="#a1a1aa" />
              <YAxis dataKey="description" type="category" tick={{ fontSize: 12 }} stroke="#a1a1aa" width={140} />
              <Tooltip />
              <Bar dataKey="amount" fill={SERVICE_INDIGO} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/ServiceCostAnalysisChart.tsx
git commit -m "feat: add ServiceCostAnalysisChart dashboard component"
```

---

## Task 15: Top Recurring Expenses list

**Files:**
- Create: `components/dashboard/TopRecurringExpensesList.tsx`

A plain list (not a chart), styled consistently with the existing `PaymentsDueList` row
pattern.

- [ ] **Step 1: Create the component**

Create `components/dashboard/TopRecurringExpensesList.tsx`:

```typescript
import type { LineItemGroupResult } from "@/services/dashboard-analytics.service";

function formatAmount(item: LineItemGroupResult): string {
  const formatted = item.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return item.currency ? `${item.currency} ${formatted}` : formatted;
}

export function TopRecurringExpensesList({ data }: { data: LineItemGroupResult[] }) {
  return (
    <div className="rounded-xl border border-[#f3e3cf] bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Top Recurring Expenses</h2>
      {data.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No recurring expenses found yet.</p>
      ) : (
        <div className="mt-2">
          {data.map((item) => (
            <div
              key={item.description}
              className="flex items-center justify-between gap-3 border-b border-zinc-100 py-2.5 last:border-0 dark:border-zinc-800"
            >
              <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{item.description}</span>
              <span className="flex-shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
                {item.invoiceCount} invoice{item.invoiceCount === 1 ? "" : "s"} · {formatAmount(item)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/TopRecurringExpensesList.tsx
git commit -m "feat: add TopRecurringExpensesList dashboard component"
```

---

## Task 16: Rewrite the dashboard page

**Files:**
- Modify: `app/page.tsx`

Replaces the pipeline-stats dashboard (now safely duplicated at `/system` in Task 7)
with the new business dashboard, composed from every component built in Tasks 10-15,
plus the existing `PaymentsDueList` unchanged.

- [ ] **Step 1: Replace `app/page.tsx`**

Replace the full contents of `app/page.tsx`:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npx eslint app/page.tsx components/dashboard components/Nav.tsx components/Footer.tsx components/StatCard.tsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: replace pipeline-stats dashboard with business dashboard"
```

---

## Task 17: Full-suite verification and manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file green, including the new
`utils/currency-aggregate.test.ts` and `services/dashboard-analytics.service.test.ts`.

- [ ] **Step 2: Full project typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Full project lint**

Run: `npx eslint .`
Expected: no errors.

- [ ] **Step 4: Manually verify in the browser**

Use the `/run` skill (or `npm run dev`) to start the app against a database that has at
least a few processed invoices, then check:
- `/` shows the KPI strip, monthly trend chart, vendor comparison, charge distribution
  donut, top recurring expenses list, and service cost analysis chart, all populated
  with real numbers (not zeros, if invoices exist) — and the existing Payments Due list
  still works at the bottom.
- `/system` shows the old pipeline-health stat cards (documents, chunks, embeddings,
  processing success/failure) — confirming the relocation didn't lose anything.
- The header shows the cream background, orange logo mark, orange active-nav-pill, and
  the small "System Health" link; the footer strip renders at the bottom of every page.
- With zero invoices in the database, the dashboard doesn't crash — every widget shows
  its "no data yet" empty state instead of an error.

- [ ] **Step 5: Final commit (only if manual verification required fixes)**

If Step 4 surfaced any issue, fix it, then:

```bash
git add -A
git commit -m "fix: address issues found during manual dashboard verification"
```

If Step 4 found nothing to fix, skip this step — there's nothing to commit.
