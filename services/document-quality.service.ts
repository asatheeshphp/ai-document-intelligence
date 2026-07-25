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

// Ordinary column/table alignment (e.g. "Description   Qty   Amount") rarely pads
// with more than ~5 consecutive whitespace characters. Runs at or beyond this length
// are treated as potential garbling artifacts rather than intentional layout.
const MIN_IRREGULAR_WHITESPACE_RUN_LENGTH = 6;

// A token counts as "recognizable" if it's alphabetic, or mostly alphanumeric with the
// punctuation normal invoice text carries (currency, dates, reference numbers), e.g.
// "INV-1001", "$1,500.00", "01/15/2026", "30" — not only pure alphabetic words. The
// lookahead requires at least one actual letter or digit somewhere in the token, so
// punctuation/currency-symbol-only noise (e.g. "$--,,", "$....", "$///") does NOT count
// as recognizable just because it's made up of "normal invoice punctuation".
const RECOGNIZABLE_WORD_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9$][A-Za-z0-9'\-/.,$]*$/;

const IRREGULAR_WHITESPACE_RUN_PATTERN = new RegExp(
  `\\s{${MIN_IRREGULAR_WHITESPACE_RUN_LENGTH},}`,
  "g",
);

// Weights below are combined into the final 0-1 score and must sum to 1.0.
const CHARS_PER_PAGE_WEIGHT = 0.3;
const ALPHANUMERIC_RATIO_WEIGHT = 0.25;
const RECOGNIZABLE_WORD_RATIO_WEIGHT = 0.35;
const WHITESPACE_REGULARITY_WEIGHT = 0.1;

if (
  Math.abs(
    CHARS_PER_PAGE_WEIGHT +
      ALPHANUMERIC_RATIO_WEIGHT +
      RECOGNIZABLE_WORD_RATIO_WEIGHT +
      WHITESPACE_REGULARITY_WEIGHT -
      1,
  ) > Number.EPSILON
) {
  throw new Error("DocumentQualityService score weights must sum to 1.0");
}

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
    const recognizableWords = tokens.filter((token) => RECOGNIZABLE_WORD_PATTERN.test(token));
    const recognizableWordRatio = tokens.length > 0 ? recognizableWords.length / tokens.length : 0;

    // Known limitation: text with very few (or zero) whitespace runs scores as fully
    // "regular" here, including a pathological single run-on token with no word breaks
    // at all — itself a common garbling artifact. Not addressed by this signal; the
    // alphanumeric/recognizable-word ratios are relied on to catch that case instead.
    const irregularRuns = trimmed.match(IRREGULAR_WHITESPACE_RUN_PATTERN) ?? [];
    const irregularWhitespaceCharCount = irregularRuns.reduce((total, run) => total + run.length, 0);
    const whitespaceIrregularity =
      trimmed.length > 0 ? Math.min(irregularWhitespaceCharCount / trimmed.length, 1) : 1;

    const charsPerPageScore = Math.min(charsPerPage / EXPECTED_CHARS_PER_PAGE, 1);
    const whitespaceRegularityScore = 1 - whitespaceIrregularity;

    const score =
      charsPerPageScore * CHARS_PER_PAGE_WEIGHT +
      alphanumericRatio * ALPHANUMERIC_RATIO_WEIGHT +
      recognizableWordRatio * RECOGNIZABLE_WORD_RATIO_WEIGHT +
      whitespaceRegularityScore * WHITESPACE_REGULARITY_WEIGHT;

    return {
      score,
      signals: { charsPerPage, alphanumericRatio, recognizableWordRatio, whitespaceIrregularity },
    };
  }
}
