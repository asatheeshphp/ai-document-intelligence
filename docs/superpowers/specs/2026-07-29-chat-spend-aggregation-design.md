# Chat Spend Aggregation — Design

## Context

`/chat` (`services/rag.service.ts`) is a classic RAG pipeline: retrieve up to 8 chunks via
the existing `SearchService`, hand them to the LLM as context, and ask it to synthesize a
grounded answer with citations. This works well for retrieval/summarization questions
("what did this invoice say," "which invoices mention GST") but has no concept of
aggregation — confirmed by reading the actual code, not assumed: it never sees more than
8 chunks, `SearchService` caps results to 1 chunk per invoice
(`MAX_RESULTS_PER_INVOICE = 1`), and the LLM is only ever asked to write prose about
whatever text it was handed, never to compute anything. Asking it "how much did I spend
with Vendor X" today would mean the model eyeball-summing a handful of scattered,
possibly-incomplete chunk excerpts — unreliable by construction, not a bug to patch.

Real per-vendor totals require a genuine database aggregation (`SUM`/`GROUP BY`), which
no amount of retrieval or better prompting can substitute for. This plan adds that
capability as a second path inside the existing chat pipeline, not a new page — chosen
explicitly over a dedicated `/vendors` page, because it keeps the "ask a natural-language
question, get a real answer" experience intact and is more demonstrable of this POC's
actual strengths (natural language, and — via the existing multilingual embeddings — not
English-only) than a filter form would be.

## Approach

### 1. Intent + entity detection (new prompt/parser in `services/ollama.service.ts`)

A new method, alongside the existing `classifyDocument`, following the exact same
pattern proven reliable there (reasoning-then-`ANSWER:`-line, **not** schema-constrained
JSON — that was measured unreliable for this model; see `buildClassificationPrompt`'s
comment):

```
detectChatIntent(question: string): Promise<ChatIntentOutcome>
```

Prompt asks the model to decide whether the question is asking for a total/spend/sum
(`AGGREGATION`) or anything else (`RETRIEVAL`), and if `AGGREGATION`, to extract a vendor
name and an optional date range, in a fixed final line:

```
ANSWER: AGGREGATION vendor=Readylink from=2026-01-01 to=2026-12-31
ANSWER: RETRIEVAL
```

`from`/`to` are omitted from the line entirely when the question doesn't mention a
period (not defaulted to any particular range) — parsed as optional groups, same style
as the existing classification parser's optional confidence group.

### 2. Real aggregation (new, separate service)

`services/spend-query.service.ts` — new, focused service, kept separate from
`RagService` because this is a genuinely different concern (deterministic DB math vs.
semantic retrieval), matching how `SearchService`/`DocumentClassifierService`/
`RagService` are already kept separate by responsibility in this codebase.

```ts
export class SpendQueryService {
  async getVendorSpendSummary(input: {
    vendorNamePattern: string;
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<{ vendorName: string | null; invoiceCount: number; totalAmount: number; currency: string | null } | null>
}
```

- Vendor matching is a case-insensitive partial match (`$regex`), reusing the exact
  pattern `SearchService`'s existing `vendorName` filter already uses — so "Readylink"
  correctly matches "Readylink Internet Services Limited" without needing the full name.
- Backed by a new repository method,
  `ProcessingRepository.getVendorSpendSummary(filter)`, running a MongoDB aggregation
  (`$match` on vendor regex + optional `invoiceDate` range, `$group` summing
  `totalAmount` and counting documents).
- Returns `null` when no invoices match (distinct from a genuine zero-total match), so
  the caller can say "no invoices found for that vendor" rather than "you spent $0."
- Currency: if matched invoices have mixed currencies, the summary reports the first
  non-null currency found and notes the mismatch in the returned data rather than
  silently summing across currencies as if they were the same unit — a real
  correctness concern, not just a formatting detail, since summing ₹ and $ amounts
  together would be a meaningless number.

### 3. Wiring into `RagService.answer()`

```ts
async answer(input: RagAnswerInput): Promise<RagAnswer> {
  const intent = await this.ollamaService.detectChatIntent(input.question);

  if (intent.type === "AGGREGATION" && intent.vendor) {
    const summary = await this.spendQueryService.getVendorSpendSummary({
      vendorNamePattern: intent.vendor,
      dateFrom: intent.from,
      dateTo: intent.to,
    });

    if (summary) {
      return { answer: formatSpendAnswer(summary, intent), sources: [], mode: "computed" };
    }
    // No match found for that vendor -- fall through to retrieval rather than dead-end,
    // in case the vendor name extraction was wrong and retrieval can still help.
  }

  // ...today's existing retrieval flow, unchanged...
  return { ...existingResult, mode: "retrieved" };
}
```

- `formatSpendAnswer` is a **fixed string template, not an LLM call** — e.g. `"You paid
  ${vendorName} ${currency}${total.toFixed(2)} across ${count} invoice(s)${dateRangeSuffix}."`
  The number is always exact, plain arithmetic and string formatting; the LLM's role is
  strictly limited to recognizing the question and extracting the vendor/date range, never
  touching the arithmetic or the final number.
- `RagAnswer` gains a `mode: "computed" | "retrieved"` field so the UI can distinguish
  the two paths.
- If intent detection fails to parse, or extraction found no vendor at all, or the
  vendor didn't match anything real, falls through to today's retrieval flow unchanged
  -- aggregation is strictly additive, never a dead end.

### 4. UI (`components/chat/ChatMessageBubble.tsx`, `app/chat/page.tsx`)

- A small badge on assistant replies: "Computed from invoice records" (aggregation
  path) vs. "Retrieved from N sources" (today's existing sources link, relabeled for
  clarity) -- visually honest about which kind of answer is being shown, and a good
  demoable signal.
- One new example question added to the existing three: `"How much have I paid
  Readylink?"` (using a real vendor name already in the sample data).

## Files touched

- `services/ollama.service.ts` (new `detectChatIntent` + prompt/parser, alongside
  existing `classifyDocument`)
- `services/spend-query.service.ts` (new)
- `repositories/processing.repository.ts` (new `getVendorSpendSummary` aggregation method)
- `services/rag.service.ts` (fork at the top of `answer()`, new `mode` field on
  `RagAnswer`)
- `components/chat/ChatMessageBubble.tsx`, `app/chat/page.tsx` (mode badge, one new
  example question)

## Out of scope for this phase (explicit)

- The earlier-discussed semantic/fuzzy vendor-category matching (e.g. "shipping
  companies" instead of a specific vendor name) -- explicitly parked; this phase is
  exact-vendor (partial-match) aggregation only, per the "plain version, not hybrid"
  decision.
- A dedicated `/vendors` page -- explicitly not built; this feature lives entirely
  inside existing `/chat`.
- Aggregating anything other than vendor spend (e.g. by date range alone with no
  vendor, by customer, by tax amount) -- only "spend with vendor X, optionally within a
  date range" is built now. Extending the intent detector to other aggregation shapes is
  a natural follow-up, not attempted here.
- Mixed-currency summation logic beyond flagging the mismatch (e.g. actual currency
  conversion) -- not attempted; flagged as a known limitation in the returned data.

## Verification

1. `npx tsc --noEmit` clean; unit tests for `SpendQueryService` (mocked repository) and
   the intent parser (mirroring `document-classifier.service.test.ts`'s pattern) covering:
   AGGREGATION with vendor + date range, AGGREGATION with vendor only, RETRIEVAL,
   unparseable response.
2. Live test against real data: ask `/chat` "How much have I paid Readylink?" — confirm
   the answer states the correct total (cross-checked against a direct DB query, not
   assumed correct because it sounds plausible) and `mode: "computed"`.
3. Live test: ask a retrieval-shaped question ("Which invoices mention GST?") — confirm
   it's unaffected, still returns `mode: "retrieved"` with the same behavior as before
   this change.
4. Live test: ask about a vendor with no invoices, and a vendor name that partially
   matches (e.g. "Readylink" instead of the full legal name) — confirm correct behavior
   in both cases.
5. Live test with a non-English question (reusing this session's existing multilingual
   test approach) to confirm intent detection isn't English-only by accident.
