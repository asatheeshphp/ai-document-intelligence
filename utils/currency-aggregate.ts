import { normalizeCurrency } from "@/utils/currency-normalize";

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
    const key = normalizeCurrency(row.currency) ?? "";
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
