const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "into",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "show", "find", "me", "please", "about", "invoice", "invoices",
  // Same "near-universal, not a real signal of relevance" reasoning as "invoice"/
  // "invoices" above, extended to the payment/tax vocabulary every invoice in this
  // corpus shares. Confirmed live: "summarize the electricity bill amount" passed
  // rag.service.ts's premise check purely because "amount" is a genuine word in the
  // named invoice's own line items (e.g. "qty 1, amount 5000") -- "electricity" itself,
  // the actual topic, never appeared anywhere. These words appear in nearly every
  // invoice's payment/tax chunk regardless of what the invoice is actually for, so
  // counting them as a relevance/grounding signal produces false matches rather than
  // real ones.
  "amount", "total", "totals", "subtotal", "tax", "taxes", "charge", "charges", "due", "payment", "payments",
]);

// A bare 4-digit token almost always reads as a calendar year in an invoice corpus, and
// every invoice here shares a year with several others (e.g. "-2026-" in most invoice
// numbers) — so it's a near-universal, non-identifying token, not a real signal of
// relevance. Confirmed live: a Tamil/Telugu query containing "2026" got a full verbatim-
// match boost against nearly every invoice's header/notes chunk purely because they all
// contain that year somewhere, flattening the ranking (every result tied at the clamped
// max). Date reasoning belongs to extractDateRangeFromQuery's dedicated filter, not here.
function looksLikeBareYear(token: string): boolean {
  return /^\d{4}$/.test(token);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 3 && !STOPWORDS.has(token) && !looksLikeBareYear(token)
  );
}

// Plain substring inclusion missed a real case: query "keyboards" against chunk text
// "Logitech Keyboard x10" silently scored 0, because "keyboards" isn't a literal
// substring of "keyboard x10" — a simple singular/plural mismatch defeated the boost
// entirely. Only this direction needs handling: a regular plural always already
// contains its singular as a substring (e.g. "keyboards" contains "keyboard"), so a
// singular query token matching plural text works without any extra step. This only
// covers the common regular "-s" case, not irregular plurals like "company"/"companies"
// — enough to fix the reported failure without overreaching into real stemming.
function tokenMatchesText(token: string, normalizedText: string): boolean {
  if (normalizedText.includes(token)) return true;

  if (token.endsWith("s") && token.length > 3) {
    return normalizedText.includes(token.slice(0, -1));
  }

  return false;
}

/**
 * Scores how much of `query`'s literal content appears in `text`, case-insensitively.
 * 1 for a verbatim substring match (e.g. an invoice number or exact vendor name), otherwise
 * the fraction of query's meaningful tokens found in text, and 0 if query has none.
 *
 * This is a lexical *complement* to vector similarity, not a replacement: no embedding
 * model guarantees an exact identifier (a verbatim vendor name or invoice number)
 * outranks a semantically-similar-but-wrong chunk purely on cosine similarity — that's
 * a keyword-match problem, not a semantic one. Literal overlap covers exactly that gap.
 */
// Lets a caller distinguish "score is 0 because nothing meaningful was asked" from
// "score is 0 because none of the meaningful words matched" -- the two need different
// handling (see rag.service.ts's premise-grounding check, which only rejects on the
// latter).
export function hasMeaningfulTokens(query: string): boolean {
  return tokenize(query).length > 0;
}

// Exposed for rag.service.ts's premise-grounding check, which needs the same
// stopword/bare-year-filtered token list this module already uses for ranking, but
// can't reuse lexicalOverlapScore's raw-substring matching for that check -- see its
// own comment for why (a filler word like "all" matching inside "allowance" is fine as
// a small ranking nudge, but wrongly defeats a veto check meant to catch zero real
// topical overlap).
export function extractMeaningfulTokens(query: string): string[] {
  return tokenize(query);
}

export function lexicalOverlapScore(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();

  if (normalizedQuery.length >= 3 && normalizedText.includes(normalizedQuery)) {
    return 1;
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const matchedTokens = queryTokens.filter((token) => tokenMatchesText(token, normalizedText));
  return matchedTokens.length / queryTokens.length;
}
