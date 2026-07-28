export interface DateRangeFilter {
  from: Date;
  to: Date;
}

// One array per language, each ordered January -> December. Extend this list as more
// query languages come up rather than trying to be exhaustive up front — a language
// with no matching row here silently falls back to unscoped search (the exact bug this
// file exists to prevent), so a missing language is a real gap, not just an omission.
const MONTH_NAMES_BY_LANGUAGE: string[][] = [
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  ["ஜனவரி", "பிப்ரவரி", "மார்ச்", "ஏப்ரல்", "மே", "ஜூன்", "ஜூலை", "ஆகஸ்ட்", "செப்டம்பர்", "அக்டோபர்", "நவம்பர்", "டிசம்பர்"],
  ["జనవరి", "ఫిబ్రవరి", "మార్చి", "ఏప్రిల్", "మే", "జూన్", "జూలై", "ఆగస్టు", "సెప్టెంబర్", "అక్టోబర్", "నవంబర్", "డిసెంబర్"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `\b` only recognizes ASCII word characters ([A-Za-z0-9_]), so it silently fails to
// bound non-Latin scripts like Tamil/Telugu — neither a space nor a Tamil letter counts
// as "\w" to it, so no boundary is ever asserted around a Tamil month name. Unicode
// letter/number property escapes (with the "u" flag) bound every script correctly.
function buildMonthPattern(monthWord: string): RegExp {
  const escaped = escapeRegExp(monthWord);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])(?:\\s+(\\d{4}))?`, "iu");
}

/**
 * Extracts a month-scoped date range from a natural-language query, e.g. "billed in
 * July", "facturado en julio", or "ஜூலை 2026-ல்". Search itself is pure semantic
 * similarity — it has no notion of "July" unless the query happens to lexically/
 * semantically resemble a July invoice — so without this, a query naming a month can
 * still return invoices from unrelated months that just scored well on general
 * phrasing. When a year isn't stated, assumes referenceDate's year (typically "now"),
 * since that's what a business user means by a bare month name in the common case.
 * Returns null if no recognized month name (in any supported language) is found.
 */
export function extractDateRangeFromQuery(query: string, referenceDate: Date = new Date()): DateRangeFilter | null {
  const lower = query.toLowerCase();

  for (const monthNames of MONTH_NAMES_BY_LANGUAGE) {
    for (let monthIndex = 0; monthIndex < monthNames.length; monthIndex += 1) {
      const match = lower.match(buildMonthPattern(monthNames[monthIndex]));
      if (!match) continue;

      const year = match[1] ? parseInt(match[1], 10) : referenceDate.getFullYear();
      const from = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
      const to = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
      return { from, to };
    }
  }

  return null;
}
