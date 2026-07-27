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

/**
 * Scores how much of `query`'s literal content appears in `text`, case-insensitively.
 * 1 for a verbatim substring match (e.g. an invoice number or exact vendor name), otherwise
 * the fraction of query's meaningful tokens found in text, and 0 if query has none.
 *
 * This is a lexical *complement* to vector similarity, not a replacement: SigLIP2's text
 * tower (trained for image-text contrastive matching, not text-to-text semantic search)
 * does not reliably rank exact keyword matches — a verbatim vendor name or invoice number
 * can score lower than an unrelated chunk in pure cosine-similarity space. Literal overlap
 * is exactly the signal that's missing there.
 */
export function lexicalOverlapScore(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();

  if (normalizedQuery.length >= 3 && normalizedText.includes(normalizedQuery)) {
    return 1;
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const matchedTokens = queryTokens.filter((token) => normalizedText.includes(token));
  return matchedTokens.length / queryTokens.length;
}
