// The extraction model copies whatever currency text appears on the invoice verbatim --
// "$", "USD", "Rs.", "INR", "₹" all show up for what are really just two currencies,
// which both fragments the dashboard's per-currency totals (summarizeByCurrency groups
// by this raw string, so "$" and "USD" for the same vendor get incorrectly treated as
// two different currencies and one gets excluded) and shows inconsistently in the UI.
// This is a fixed lookup, not a guess -- unrecognized values are returned trimmed and
// uppercased rather than dropped, so a real-but-uncommon code (e.g. "AED") still shows
// up as itself instead of disappearing.
const CURRENCY_ALIASES: Record<string, string> = {
  "$": "USD",
  "US$": "USD",
  "USD$": "USD",
  "RS": "INR",
  "RS.": "INR",
  "₹": "INR",
  "INR.": "INR",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  return CURRENCY_ALIASES[upper] ?? upper;
}
