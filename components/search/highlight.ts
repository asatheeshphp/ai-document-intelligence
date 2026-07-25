const STOPWORDS = new Set([
  "find",
  "show",
  "search",
  "invoice",
  "invoices",
  "with",
  "from",
  "containing",
  "contains",
  "the",
  "a",
  "an",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "and",
  "or",
  "is",
  "are",
  "this",
  "that",
]);

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function getHighlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    )
  );

  if (terms.length === 0) {
    return [{ text, match: false }];
  }

  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: terms.includes(part.toLowerCase()),
    }));
}
