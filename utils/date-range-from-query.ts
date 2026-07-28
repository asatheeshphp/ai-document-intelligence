export interface DateRangeFilter {
  from: Date;
  to: Date;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Extracts a month-scoped date range from a natural-language query, e.g. "billed in
 * July" or "invoices from March 2024". Search itself is pure semantic similarity — it
 * has no notion of "July" unless the query happens to lexically/semantically resemble
 * a July invoice — so without this, a query naming a month can still return invoices
 * from unrelated months that just scored well on general phrasing. When a year isn't
 * stated, assumes referenceDate's year (typically "now"), since that's what a business
 * user means by a bare month name in the common case. Returns null if no month is named.
 */
export function extractDateRangeFromQuery(query: string, referenceDate: Date = new Date()): DateRangeFilter | null {
  const lower = query.toLowerCase();

  for (let monthIndex = 0; monthIndex < MONTH_NAMES.length; monthIndex += 1) {
    const monthPattern = new RegExp(`\\b${MONTH_NAMES[monthIndex]}\\b(?:\\s+(\\d{4}))?`, "i");
    const match = lower.match(monthPattern);
    if (!match) continue;

    const year = match[1] ? parseInt(match[1], 10) : referenceDate.getFullYear();
    const from = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
    return { from, to };
  }

  return null;
}
