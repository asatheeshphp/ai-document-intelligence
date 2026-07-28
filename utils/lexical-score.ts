const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "into",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "show", "find", "me", "please", "about", "invoice", "invoices",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 3 && !STOPWORDS.has(token)
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
