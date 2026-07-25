export interface DocumentQualitySignals {
  charsPerPage: number;
  alphanumericRatio: number;
  recognizableWordRatio: number;
  whitespaceIrregularity: number;
}

export interface DocumentQualityResult {
  score: number;
  signals: DocumentQualitySignals;
}

// A page with roughly this many characters of body text is treated as "plenty of
// text" (score contribution saturates at 1) — calibrated against typical single-page
// invoices, not a hard limit.
const EXPECTED_CHARS_PER_PAGE = 500;

export class DocumentQualityService {
  assess(text: string, pageCount: number): DocumentQualityResult {
    const trimmed = text.trim();
    const effectivePages = Math.max(pageCount, 1);

    const charsPerPage = trimmed.length / effectivePages;

    const nonWhitespace = trimmed.replace(/\s/g, "");
    const alphanumericMatches = nonWhitespace.match(/[A-Za-z0-9]/g) ?? [];
    const alphanumericRatio =
      nonWhitespace.length > 0 ? alphanumericMatches.length / nonWhitespace.length : 0;

    const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
    const recognizableWords = tokens.filter((token) => /^[A-Za-z][A-Za-z'-]*$/.test(token));
    const recognizableWordRatio = tokens.length > 0 ? recognizableWords.length / tokens.length : 0;

    const irregularRuns = trimmed.match(/\s{3,}/g) ?? [];
    const whitespaceIrregularity =
      trimmed.length > 0 ? Math.min(irregularRuns.length / (trimmed.length / 100), 1) : 1;

    const charsPerPageScore = Math.min(charsPerPage / EXPECTED_CHARS_PER_PAGE, 1);
    const whitespaceRegularityScore = 1 - whitespaceIrregularity;

    const score =
      charsPerPageScore * 0.3 +
      alphanumericRatio * 0.25 +
      recognizableWordRatio * 0.35 +
      whitespaceRegularityScore * 0.1;

    return {
      score,
      signals: { charsPerPage, alphanumericRatio, recognizableWordRatio, whitespaceIrregularity },
    };
  }
}
