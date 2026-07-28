# E5 Hybrid Search — Implementation Record

> This documents work already completed and verified, not a forward plan. Tasks are
> marked `[x]` with the verification evidence that closed them. Supersedes
> `docs/superpowers/plans/2026-07-25-siglip2-embedding-migration-plan.md`.

**Reference spec:** `docs/superpowers/specs/2026-07-28-e5-hybrid-search-design.md`

---

### Task 1: Benchmark SigLIP2 vs. multilingual-e5-base before committing to a migration

- [x] Ran the identical 40-query set (10 intents × English/Spanish/Tamil/Telugu) against
      both models over the same corpus.
- [x] SigLIP2: 3/10 English recall@1, 0.0085 average top-2 margin, genuine/nonsense
      scores fully interleaved.
- [x] E5: 9/10 English recall@1, 7/10 Spanish, 4/10 Tamil, 4/10 Telugu, 4/4 on
      zero-word-overlap English paraphrases.
- **Decision:** proceed with E5 migration, per explicit approval ("go ahead and implement
  the E5 migration").

### Task 2: `e5-service/` sidecar

- [x] FastAPI service loading `intfloat/multilingual-e5-base`, `/health` and
      `/embed-text` (`{text, kind}` → `{embedding, dimension}`), asymmetric
      `"query: "`/`"passage: "` prefixing per E5's training convention.
- [x] `siglip-service/` deleted entirely, including stray `uvicorn`/`python` processes
      that had to be force-killed before the folder could be removed on Windows.

### Task 3: `services/e5.service.ts` Node client

- [x] `embedText(text, kind: "query" | "passage")`, replaces deleted
      `services/siglip.service.ts` at both call sites (`invoice-indexing.service.ts`,
      `search.service.ts`).

### Task 4: Re-embed existing corpus, recalibrate thresholds

- [x] Re-ran genuine-vs-nonsense calibration sweep against the E5-embedded corpus (see
      the constants table in the spec doc).
- [x] `DEFAULT_THRESHOLD`, `MIN_SIGNAL_GAP`, `HIGH_CONFIDENCE_MARGIN` updated with
      measured values and explanatory comments in `search.service.ts`.

### Task 5: Fix top-1 ranking / duplicate-result issues carried over from SigLIP2 era

- [x] `LEXICAL_BOOST` (additive literal-overlap score) confirmed still needed post-
      migration — no embedding model guarantees an exact identifier outranks a
      semantically-similar-but-wrong chunk.
- [x] `MAX_RESULTS_PER_INVOICE` tightened 3 → 1 after live testing showed 3 still let an
      unrelated invoice's non-matching chunks pollute results.
- [x] Display score clamped to 1 (`Math.min(item.score, 1)`) — internal
      ranking/threshold/gap-check logic stays unclamped; only the displayed percentage is
      capped.

### Task 6: Multi-language date-range recognition + bare-year fix

- [x] `utils/date-range-from-query.ts` recognizes month names in English, Spanish,
      French, Tamil, Telugu, using Unicode-aware boundaries (`\p{L}`/`\p{N}`
      lookarounds — `\b` silently fails to bound non-Latin scripts).
- [x] `looksLikeBareYear` added to `utils/lexical-score.ts` — a bare 4-digit token (e.g.
      "2026") was flattening Tamil/Telugu rankings by verbatim-matching nearly every
      invoice's header.
- [x] Plural/singular lexical matching gap fixed ("keyboards" vs. "Keyboard").

### Task 7: Day-level date filtering — attempted, reverted

- [x] Implemented day-adjacent-to-month parsing (`"July 22"`, `"22nd of July"`, ordinal
      suffixes, days-in-month validation).
- [x] Live verification found a regression: `"delivery was made on July 22"` returned
      zero results because the invoice's actual `invoiceDate` was July 20 — the day named
      in the query was a delivery date (free text), not the invoice date the hard filter
      checks.
- [x] Confirmed via direct DB check (`invoiceDate` field vs. what the query's "22"
      resolved to) before concluding — not assumed.
- [x] Reverted to month-only scoping after confirming stated POC use cases are all
      month-granularity ("this month", "July month"). `utils/date-range-from-query.ts`
      and its test file rolled back; 10/10 tests passing, `tsc` clean. Committed as
      `bd40747`.

### Task 8: Translation fallback for non-English, no-anchor queries

- [x] `OllamaService.translateToEnglish` added.
- [x] `SearchService.search` retries once via translation only when the primary search
      is empty and the query isn't plain ASCII — confirmed via live testing this doesn't
      fire for queries that already succeed or are already English.
- [x] Telugu translation quality tested with 5 phrasing variants — confirmed a model
      capability limitation (hallucinated output regardless of phrasing), not a fallback
      mechanism bug. Explicitly dropped, not pursued further.

### Task 9: Search UX

- [x] Default display count 10 → 5 (`app/search/page.tsx`).
- [x] Removed hardcoded `threshold: 0.45` UI override that was silently beating the
      server's calibrated `DEFAULT_THRESHOLD` on every UI-driven search.
- [x] Linked each result to the existing `DocumentDetailsDrawer` (reused, not
      rebuilt) instead of a new page/view.
- [x] Added a custom, non-native info-icon tooltip (`InfoTooltip.tsx`) explaining
      chunk-type tags, per explicit instruction to avoid the native browser tooltip.

### Task 10: Location-based search — tested live before building anything

- [x] Confirmed route-style queries already rank correctly via the existing hybrid
      pipeline, no new filter needed.
- [x] Confirmed bare city-name queries carry structural noise (city mentioned in an
      unrelated role — e.g. customer address vs. shipment destination); judged not worth
      a new structured field for this POC.
- [x] Investigated an apparent "invoice"-keyword false positive; disproved via direct
      test (`lexicalOverlapScore` returns 0 for that pair — "invoice"/"invoices" already
      in `STOPWORDS`); root cause is vector-similarity noise at the threshold boundary,
      not a lexical bug. Left as-is, same accepted tradeoff as elsewhere.

### Task 11: Non-logistics invoice generality — verified, not assumed

- [x] Ingested a synthetic consulting/service invoice (no shipping, no logistics
      language) through the real pipeline.
- [x] Confirmed classification (`INVOICE`, confidence 1), extraction (all fields
      correct, `shipping` cleanly null, tax-hallucination filter correctly dropped
      bogus CGST/SGST/IGST/VAT/duty entries), chunking, and indexing all worked
      unmodified.
- [x] Confirmed targeted search queries rank it correctly at score 1.
- [x] Confirmed a bare month-only query missing it is the same pre-existing
      threshold/gap-check tradeoff affecting logistics invoices too, not something
      specific to service invoices (checked via direct threshold-bypassed query showing
      all 4 July candidates sitting just under `DEFAULT_THRESHOLD`).

### Explicitly out of scope (decided, not deferred by omission)

- [x] Exact-amount matching — dropped.
- [x] RAG chat completeness — dropped.
- [x] File-upload endpoint — dropped.
- [x] Retry/escalation path — dropped.
- [x] Non-invoice-type structured extraction — dropped.
- [x] Status-based filtering — explicitly left out of scope; requires a new schema
      field or computed condition, real scope decision for later.

---

## Verification summary

- `npx tsc --noEmit`: clean at every step.
- `npm test` (Vitest): passing at every step (pre-existing unrelated sample-PDF test
  failure aside).
- Every functional claim in this record was checked against the live dev server and
  real ingested data via `curl`/debug scripts, not inferred from code reading alone.
