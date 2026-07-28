# E5 Hybrid Search — Current Design

## Context

This supersedes `docs/superpowers/specs/2026-07-25-siglip2-embedding-migration-design.md`.
That plan shipped, but a live 40-query benchmark (10 intents × English/Spanish/Tamil/
Telugu) run against real re-indexed invoice data found SigLIP2's text-to-text
discrimination too weak to trust — even in English (3/10 raw recall@1, genuine and
nonsense query scores fully interleaved, no threshold able to separate them). SigLIP2 is
trained for image↔text contrastive matching, not text↔text retrieval, and the benchmark
confirmed that mismatch directly rather than by inference from documentation.

`multilingual-e5-base` was benchmarked head-to-head on the identical 40 queries before
switching: 9/10 English recall@1, 7/10 Spanish, 4/10 Tamil, 4/10 Telugu, and a perfect
4/4 on English queries phrased with zero words in common with the target text (the
direct test of "understands meaning, not just matching words"). This document describes
what actually shipped as a result, plus everything decided in search/filtering
discussions afterward.

## Architecture

Search is **hybrid**, not vector-only, by deliberate design — pure vector similarity
cannot enforce a hard boundary (e.g. "only July") or exact-identifier precedence (e.g. an
invoice number outranking a semantically-similar-but-wrong chunk). The pipeline, in
order:

1. **Embed** the query via `E5Service.embedText(query, "query")` — 768-dim,
   `multilingual-e5-base`, served by the `e5-service/` FastAPI sidecar.
2. **Hard filter** (optional): if the query names a month (`utils/date-range-from-query.ts`)
   or explicit filters are passed (`vendorName`, `customerName`, date range), matching
   invoice IDs are resolved first and candidates outside that set are excluded entirely —
   not down-ranked.
3. **Score** each remaining candidate: `vectorScore (cosine similarity) + LEXICAL_BOOST *
   lexicalOverlapScore(query, chunkText)` — see `utils/lexical-score.ts`. This is additive
   and zero for queries with no literal overlap, so it never affects purely semantic or
   multilingual matches; it only strengthens ranking when the query's own words actually
   appear in the chunk (e.g. an exact vendor name or invoice number).
4. **Signal-gap safety net**: if there are ≥3 candidates and the top score is below
   `threshold + HIGH_CONFIDENCE_MARGIN`, and the gap between the top score and the mean
   score is below `MIN_SIGNAL_GAP`, return no results rather than a low-confidence guess.
5. **Threshold filter + per-invoice cap**: keep only candidates scoring ≥ `threshold`,
   cap results to `MAX_RESULTS_PER_INVOICE = 1` per invoice (a single invoice can have
   15–20+ chunks; without this cap one invoice can crowd out every other candidate).
6. **Translation fallback** (query-level, wraps the whole pipeline above): if the primary
   search returns nothing and the query isn't plain ASCII, translate to English via
   `OllamaService.translateToEnglish` and retry once. This exists because non-English
   queries with no literal anchor (no shared proper noun/number with the target text)
   measured with scores fully interleaved with nonsense-query scores — no threshold value
   separates them. Only a fallback: a query that already found results, or is already
   plain ASCII, skips the extra round trip.

Calibrated constants (`services/search.service.ts`), each measured against the real
re-embedded corpus, not guessed:

| Constant | Value | Basis |
|---|---|---|
| `DEFAULT_THRESHOLD` | 0.8 | Genuine top scores measured 0.8391–0.8815; nonsense top scores 0.7746–0.7999 — sits in the clean gap between them |
| `MIN_SIGNAL_GAP` | 0.045 | Above the measured nonsense gap ceiling (0.0379), below the lowest genuine gap (0.0649) |
| `HIGH_CONFIDENCE_MARGIN` | 0.15 | Unchanged from the SigLIP2 era — no genuine query has cleared threshold + 0.15, so the gap check still runs on every real query |
| `LEXICAL_BOOST` | 0.5 | Unchanged — additive keyword-match complement to vector similarity |
| `MAX_RESULTS_PER_INVOICE` | 1 | Unchanged — kept conservative even though E5's cleaner score separation makes crowding less likely; no measured evidence a higher cap is safe yet |

Both `DEFAULT_TOP_K` (10) and the UI's requested display count (5, see below) are
independent of each other — the service still returns up to `topK` results; the frontend
just requests/shows fewer by default.

## Date-range extraction (`utils/date-range-from-query.ts`)

Recognizes a month name — English, Spanish, French, Tamil, or Telugu — optionally with an
explicit year, and returns a whole-month `{from, to}` range. Matches "billed in July",
"July 2026", "ஜூலை 2026-ல்", etc. Unicode-aware boundaries (`\p{L}`/`\p{N}` lookarounds,
not `\b`) are required because `\b` only recognizes ASCII word characters and silently
fails to bound non-Latin scripts.

**Day-level narrowing was attempted and reverted.** A day number adjacent to the month
("July 22") was parsed and applied as a hard filter on the exact day. Live verification
showed this caused false negatives: "delivery was made on July 22" hard-excluded the
correct invoice because its `invoiceDate` was actually July 20 — the day named in the
query referred to the *delivery* date (free text, not a structured field), not the
invoice date the filter checks. The stated POC use cases ("invoices received this month",
"received in July month") are month-granularity only, so day-level parsing solved a
problem that doesn't exist for this product while introducing a real regression risk.
Reverted to month-only; not revisited unless day-granularity becomes an actual
requirement.

## Search UX

- Frontend defaults to showing **5** results (not the service's `DEFAULT_TOP_K = 10`) —
  a display-layer choice, `app/search/page.tsx`.
- The UI no longer hardcodes `threshold: 0.45` (a stale SigLIP2-era value) — it was
  silently overriding the server's calibrated `DEFAULT_THRESHOLD` on every UI search.
  `SearchFiltersValue.threshold` is now `number | null`, defaulting to `null`, and is only
  sent when explicitly set by the user.
- Each result links to the existing `DocumentDetailsDrawer` (slide-in drawer, not a page
  navigation) for the full invoice, rather than a new view.
- Chunk-type tags (`Line Items`, `Notes`, etc.) show a custom info-icon tooltip
  (`components/search/InfoTooltip.tsx`) explaining what that chunk type means — a
  deliberately non-native tooltip, not the browser's `title` attribute.

## Location-based search — tested, no new code

Live-tested rather than assumed. Specific, route-style queries ("transportation from
Coimbatore to Chennai") already rank correctly via the existing hybrid pipeline — no
change needed. Bare city-name queries ("invoices shipped to Hamburg") surface some
unrelated invoices that merely mention the city elsewhere (e.g. a customer's billing
address, not a shipment destination) — this is a structural limitation (no field
distinguishes a city's *role* on the invoice), same root cause as the date problem, and
was judged not worth building a structured "destination" field for. A separate false
positive found during this test (generic invoice-header chunks scoring ~0.80, right at
threshold, for a query containing the word "invoices") turned out to be pure vector-
similarity noise, not a lexical bug — `"invoice"`/`"invoices"` are already excluded via
`STOPWORDS` in `utils/lexical-score.ts`, confirmed by direct test
(`lexicalOverlapScore(...) === 0` for that exact pair). Left as-is; same
threshold-boundary tradeoff already accepted elsewhere.

## Non-logistics invoice generality — confirmed, not assumed

The extraction schema, prompt, and chunk types (`header`, `supplier`, `customer`,
`line_items`, `taxes`, `payment`, `notes`, `footer`, `other`) contain nothing
logistics-specific — the sample corpus being logistics-heavy is a data coincidence, not a
code dependency. Verified by ingesting a synthetic consulting/service invoice (no
shipping, no logistics language) through the real pipeline end-to-end: classified as
`INVOICE`, extraction/chunking/indexing succeeded, `shipping` fields correctly stayed
null, the tax-hallucination filter correctly dropped bogus CGST/SGST/IGST entries the
model tried to add, and targeted search queries ranked it correctly at score 1.

## Explicitly out of scope (not pursued)

- Exact-amount matching
- Telugu translation quality (model-capability limitation, not a bug in the fallback
  mechanism — confirmed via 5 phrasing variants, all hallucinated)
- RAG chat completeness
- File-upload endpoint
- Retry/escalation path
- Non-invoice-type structured extraction
- Day-level date filtering (attempted, reverted — see above)
- Status-based filtering — `invoice.status` today is a pipeline status
  (`NEW/EXTRACTED/VALIDATED/FAILED`), not a business status (paid/overdue/delivered).
  Building this needs either a new schema field or a computed condition
  (e.g. `overdue = dueDate < now`) plus query-side keyword recognition. Real scope
  decision, deliberately left for later.

## Files touched (cumulative, vs. the superseded SigLIP2 plan)

- `e5-service/` (new sidecar, replaces deleted `siglip-service/`)
- `services/e5.service.ts` (new, replaces deleted `services/siglip.service.ts`)
- `services/search.service.ts` (hybrid pipeline, recalibrated constants, translation
  fallback)
- `services/ollama.service.ts` (`translateToEnglish` added)
- `utils/lexical-score.ts` (lexical overlap scoring, stopwords, bare-year exclusion,
  plural/singular matching)
- `utils/date-range-from-query.ts` (month-only date-range extraction, multi-language)
- `app/search/page.tsx`, `components/search/SearchFilters.tsx`,
  `components/search/SearchResultCard.tsx`, `components/search/chunkTypeInfo.ts`,
  `components/search/InfoTooltip.tsx` (search UX)

## Verification performed

All of the following were run against the live dev server and real ingested data, not
mocked:

1. `npx tsc --noEmit` clean; `npm test` (Vitest) passing after each change.
2. 40-query SigLIP2-vs-E5 benchmark (English/Spanish/Tamil/Telugu × 10 intents).
3. Genuine-vs-nonsense calibration sweep across 5 languages, informing the constants
   table above.
4. Live `curl` verification of date filtering, including the day-level regression that
   led to its revert.
5. Live `curl` verification of location-based queries (route-style vs. bare city name).
6. End-to-end ingestion test of a synthetic non-logistics service invoice, followed by
   targeted search verification.
