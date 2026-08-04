# Business Dashboard Redesign — Design

## Problem

The current dashboard (`app/page.tsx`) is the app's landing screen, but it only shows
processing-pipeline health: total documents, total invoices, total chunks, total
embeddings, average chunks/document, processing success/failure counts. That's useful
while building the ingestion pipeline, but meaningless to a business user (or an
audience seeing the product for the first time) — it answers "is the system working?"
not "what do I need to know about my invoices?"

## Goal

Replace the dashboard's primary content with a finance/accounts-payable-style view,
computed entirely from real extracted invoice data (never mock numbers):

1. Monthly spending trend
2. Vendor comparison
3. Service cost analysis
4. Top recurring expenses
5. Average invoice value
6. Charge distribution (subtotal / tax / discount / shipping)
7. A KPI strip (total spend, avg invoice value, overdue, due within 30 days)
8. The existing overdue/due-soon payments list, kept as-is

The old pipeline/system-health stats move to a secondary page rather than disappearing.

Alongside this, the app gets an overall visual theme refresh (currently near-unstyled
zinc/white with no footer), incorporating TechGrit's brand orange as an accent color.

## Out of scope

- A dark-mode redesign — dark mode keeps its current basic zinc/black auto-following
  variant (unchanged); only the light theme gets fully designed.
- A manual light/dark toggle.
- Fuzzy/semantic grouping of line-item descriptions for the recurring-expense and
  service-cost widgets (see "Known limitation" under Widget 3/4 below) — exact
  normalized-string grouping only.
- Date-range filtering/customization on the dashboard (e.g., "show last quarter") — all
  widgets use fixed, sensible default windows (see each widget's spec). Can be added
  later without changing this design's shape.
- Currency conversion — mixed-currency totals are flagged, never silently summed (see
  "Multi-currency handling").
- Rebuilding/relocating the pipeline-stats UI beyond a straight move to a new page.

## Layout

Approved via visual companion mockup (`layout-full.html`, KPI-strip-and-trend base,
option "A"). Top to bottom:

1. **KPI strip** — 4 cards: Total Spend (YTD), Avg Invoice Value, Overdue, Due in 30 Days.
2. **Monthly Spending Trend** — full-width bar chart. (Together with the KPI strip, this
   is what's visible above the fold.)
3. **Vendor Comparison** (ranked horizontal bars) + **Charge Distribution** (donut),
   side by side.
4. **Top Recurring Expenses** (ranked list) + **Service Cost Analysis** (ranked bars),
   side by side.
5. **Payments Due** — the existing `PaymentsDueList` component, unchanged in behavior,
   restyled for the new theme.

## Data layer

New `services/dashboard-analytics.service.ts`, one focused method per widget, each
running a Mongo `$match`/`$group` aggregation directly against the `Invoice` collection
— following the same pattern as `ProcessingRepository.getVendorSpendSummary` (real
SUM/COUNT via aggregation, never an LLM-computed number). No changes to existing
services (`InvoiceStatusQueryService`, `SpendQueryService`, etc.) — the KPI strip's
overdue/due-soon figures directly reuse `InvoiceStatusQueryService.listByStatus("OVERDUE")`
and `listByStatus("UPCOMING", 30)`, since that logic already exists and is already tested.

### Multi-currency handling

Every SUM-producing widget groups by currency internally. If the result set spans
exactly one currency, the widget displays a plain total in that currency. If it spans
more than one, the widget displays the dominant currency's total with a note (e.g. "+2
invoices in other currencies not included") — the same "flag, don't silently mix units"
principle `formatSpendAnswer` in `rag.service.ts` already established for chat answers.

### Widget specs

**1. KPI Strip** (`getKpiSummary()`)
- Total Spend (YTD): `SUM(totalAmount)` where `invoiceDate >= Jan 1 of current year`.
- Avg Invoice Value: `AVG(totalAmount)` across all invoices (all-time, not YTD-scoped —
  a small-sample YTD average would be noisy early in the year).
- Overdue: `InvoiceStatusQueryService.listByStatus("OVERDUE")`, summed.
- Due in 30 Days: `InvoiceStatusQueryService.listByStatus("UPCOMING", 30)`, summed.

**2. Monthly Spending Trend** (`getMonthlySpendTrend(months = 12)`)
- Group by `{ year, month }` of `invoiceDate`, `SUM(totalAmount)`, trailing N months
  (default 12) so the chart doesn't grow unbounded as more history accumulates.
- Sorted chronologically. Months with zero invoices show as a zero bar (not omitted),
  so the trend line reads correctly.

**3. Vendor Comparison** (`getVendorComparison(topN = 8)`)
- Group by `vendorName`, `SUM(totalAmount)`, sort descending, top N. No "Other" bucket
  for the remainder in v1 — simplicity over completeness for a first-screen widget.

**4. Service Cost Analysis** (`getServiceCostAnalysis(topN = 8)`)
- Reads `extractedData.lineItems` across all invoices (not chunk text — this is
  structured data already stored per-invoice at extraction time). Groups by normalized
  description (lowercase, trimmed, whitespace-collapsed), `SUM(amount)`, sort
  descending by total, top N.
- **Known limitation**: exact-string grouping only. "Internet Service" and "Internet
  Services - Monthly" are two different groups. Acceptable for v1; a future iteration
  could cluster semantically-similar descriptions, but that's a meaningfully bigger
  feature (embedding-based clustering or an LLM categorization pass) and is explicitly
  out of scope here.

**5. Top Recurring Expenses** (`getTopRecurringExpenses(topN = 5)`)
- Same underlying line-item grouping as Service Cost Analysis (shared internal
  function, parameterized differently), but filtered to descriptions appearing in 2+
  distinct invoices (the "recurring" qualifier), sorted by total amount descending.
  Displays both the invoice count and total per entry (e.g. "3 invoices · ₹1,767").

**6. Charge Distribution** (`getChargeDistribution()`)
- `SUM(subtotal)` and `SUM(taxAmount)` from the `Invoice` model's own top-level fields
  (already structured/indexed there). `SUM(discount)` and `SUM(shippingCharge)` from
  `extractedData.totals`, since those two fields aren't promoted to top-level `Invoice`
  columns. Rendered as a donut: subtotal / tax / discount / shipping shares.

## API

One new route, `app/api/dashboard/business/route.ts`, calls all six
`DashboardAnalyticsService` methods (via `Promise.all`) and returns them in a single
JSON payload — one fetch for the whole dashboard, matching the existing
`/api/dashboard/stats` pattern. The existing `/api/dashboard/stats` and
`/api/invoices/due` routes are unchanged and untouched.

## Page & components

- `app/page.tsx` is rewritten to fetch `/api/dashboard/business` once and pass slices
  down to new, focused presentational components:
  - `components/dashboard/KpiStrip.tsx`
  - `components/dashboard/MonthlySpendTrendChart.tsx`
  - `components/dashboard/VendorComparisonChart.tsx`
  - `components/dashboard/ChargeDistributionChart.tsx`
  - `components/dashboard/ServiceCostAnalysisChart.tsx`
  - `components/dashboard/TopRecurringExpensesList.tsx`
- `components/PaymentsDueList.tsx` stays at the bottom of the page, logic unchanged,
  restyled only for the new theme (see below).
- The old pipeline/system-health UI (the current contents of `app/page.tsx`) moves to a
  new `app/system/page.tsx`, reusing `/api/dashboard/stats` and `StatCard` as-is — a
  relocation, not a rebuild. Linked via a small, muted text link in the `Nav` header
  (visually separate from the primary Dashboard/Documents/Search/Chat pills), not a
  primary tab — it's not for the target first-screen audience. The footer stays a pure
  branding strip with no links, matching the "minimal branding strip" choice.
- **Recharts** is added as a new dependency for the bar and donut charts (confirmed —
  no charting library exists in the project today).

## Theme

Direction: **Warm Cream + Orange**, approved via visual companion mockup
(`light-theme.html`). Light theme is the fully-designed primary target; dark mode keeps
its current basic auto-following zinc/black variant, unchanged.

- `app/globals.css`: add cream background and orange brand-accent CSS custom
  properties (light theme only).
- `components/Nav.tsx`: cream/white header background; orange used for the active nav
  pill and a small logo mark; a small muted "System Health" text link added alongside
  the primary nav pills (see Migration notes).
- New `components/Footer.tsx`: minimal branding strip only (product name + "© ...
  TechGrit"), no links. Wired into `app/layout.tsx` below `<main>`.
- **Status colors are untouched**: overdue stays red-orange (`#c2410c` light /
  `#fb923c` dark), due-soon stays amber (`#b45309` / `#fbbf24`), paid/success stays
  emerald — all deliberately distinct hues from the brand orange (`#FF9A2E` →
  `#F5720C`) so chart/brand color and payment-status color are never visually
  ambiguous. Brand orange is used for: the trend chart's bars, the top vendor-bar
  highlight, the active nav pill, primary buttons, and the logo mark.

## Error handling

Every `DashboardAnalyticsService` method returns an empty-safe default (`0`, `[]`, or
`null` fields) rather than throwing when no invoices exist yet — matching the existing
"No documents indexed yet" empty state already in `app/page.tsx`. The API route wraps
all six calls in one `Promise.all` inside a try/catch, returning
`{ success: false, error }` on failure, matching `/api/dashboard/stats`'s existing
shape.

## Testing

Unit tests for each new `DashboardAnalyticsService` method at the service/repository
layer (Vitest, mirroring existing tests like `line-item-aggregation.service.test.ts`):
correct grouping/summing, multi-currency flagging, empty-database behavior, and the
recurring-vs-non-recurring split for line items. No new component-test infrastructure is
introduced — the codebase has no React Testing Library setup today, and this design
doesn't require adding one; component correctness is verified by running the app
(`/run` skill) against real seeded data.

## Migration notes

- `app/page.tsx`'s current contents move to `app/system/page.tsx` verbatim (same
  fetch logic, same `StatCard` usage) before the new dashboard content replaces
  `app/page.tsx` — this keeps the pipeline-stats view available with zero behavior
  change, just relocated.
- No database schema changes — every widget reads existing `Invoice` fields and
  `extractedData` that's already being stored today.
