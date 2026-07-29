# Chat Spend Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/chat` correctly answer vendor-spend questions ("how much have I paid
Vendor X") with a real, exact database total, instead of the current retrieval-only
pipeline eyeball-summing a handful of chunk excerpts. Everything stays inside the
existing chat UI — no new page.

**Architecture:** A new intent-detection step runs first inside `RagService.answer()`.
If the question is recognized as a spend/total question with a resolvable vendor name,
it's routed to a new `SpendQueryService` running a real MongoDB aggregation, and the
answer is built from a fixed string template (never the LLM) so the number is always
exact. Anything else falls through to today's existing retrieval flow, unchanged.

**Tech stack:** TypeScript/Node (existing app), MongoDB aggregation pipeline (existing
DB, no schema changes), Vitest (existing test runner), Ollama (existing chat model, new
prompt only).

**Reference spec:** `docs/superpowers/specs/2026-07-29-chat-spend-aggregation-design.md`

---

### Task 1: Intent + entity detection

**Files:** `services/ollama.service.ts`, `services/ollama.service.test.ts`

- [ ] Add `detectChatIntent(question: string): Promise<ChatIntentOutcome>`, following
      the exact reasoning-then-`ANSWER:`-line pattern already proven reliable for
      `classifyDocument` (not schema-constrained JSON).
- [ ] Prompt asks the model to output `AGGREGATION` (with `vendor=`, optional `from=`/
      `to=`) or `RETRIEVAL` on the final line.
- [ ] Parser: both the vendor/date fields and their absence are handled — a
      spend-shaped question with no date mentioned should still parse cleanly as
      `AGGREGATION` with only a vendor, no dates.
- [ ] Unit tests: AGGREGATION with vendor + full date range; AGGREGATION with vendor
      only; RETRIEVAL; a response with no parseable answer line at all (should fail
      gracefully, not throw).

### Task 2: Vendor spend aggregation query

**Files:** `repositories/processing.repository.ts`,
`repositories/processing.repository.test.ts` (new -- confirmed no test file exists yet
for this repository), `services/spend-query.service.ts` (new), matching test file

- [ ] `ProcessingRepository.getVendorSpendSummary({ vendorNamePattern, dateFrom?, dateTo?
      })` — MongoDB aggregation: `$match` on `vendorName` (case-insensitive regex,
      matching `SearchService`'s existing vendor-filter pattern) + optional `invoiceDate`
      range, `$group` summing `totalAmount` and counting documents. Returns `null` when
      no invoices match (distinct from a genuine zero total).
- [ ] Currency-mismatch handling: if matched invoices span more than one currency, the
      summary flags this rather than silently summing incompatible units.
- [ ] `SpendQueryService.getVendorSpendSummary(...)` thin wrapper over the repository
      method (kept as its own service per the design doc's separation-of-concerns
      reasoning).
- [ ] Unit tests: single vendor/single currency match; no match (null); mixed-currency
      match (flagged, not silently summed); date range narrowing the match set.

### Task 3: Wire into `RagService.answer()`

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts` (new -- confirmed no
test file exists yet for this service)

- [ ] Fork at the top of `answer()`: call `detectChatIntent` first. On `AGGREGATION`
      with a vendor, call `SpendQueryService`; build the answer from a **fixed string
      template**, not an LLM call — the model never touches the arithmetic or the final
      number.
- [ ] `RagAnswer` gains `mode: "computed" | "retrieved"`.
- [ ] No vendor match found for an `AGGREGATION`-classified question: falls through to
      today's existing retrieval flow rather than dead-ending — aggregation is strictly
      additive.
- [ ] Existing retrieval flow (RETRIEVAL-classified questions) is provably unchanged --
      same inputs, same outputs as before this change, just with `mode: "retrieved"`
      added.
- [ ] Unit tests: aggregation-path question with a real match; aggregation-path question
      with no match (falls through to retrieval); retrieval-path question (existing
      behavior preserved); intent detection failure (falls through to retrieval, not an
      error).

### Task 4: UI

**Files:** `components/chat/ChatMessageBubble.tsx`, `app/chat/page.tsx`

- [ ] Small badge on assistant replies distinguishing "Computed from invoice records"
      (aggregation) from "Retrieved from N sources" (today's existing sources
      link, relabeled).
- [ ] Add one new example starter question using a real vendor name already in the
      sample data (e.g. "How much have I paid Readylink?").

### Task 5: Live verification

- [ ] `npx tsc --noEmit` clean; full `npm test` passing (pre-existing unrelated
      sample-PDF failure aside).
- [ ] Ask `/chat` "How much have I paid Readylink?" — confirm the total matches a
      direct DB check (not assumed correct because it sounds plausible), `mode:
      "computed"`.
- [ ] Ask a retrieval-shaped question ("Which invoices mention GST?") — confirm
      unaffected, `mode: "retrieved"`, same answer quality as before this change.
- [ ] Ask about a vendor with zero invoices, and a partial vendor name (e.g.
      "Readylink" instead of the full legal name) — confirm both behave correctly.
- [ ] Ask a spend question in a non-English language already used for testing earlier
      this session — confirm intent detection isn't accidentally English-only.

---

## Out of scope for this plan (explicit)

- Semantic/fuzzy vendor-category matching (e.g. "shipping companies") -- exact
  (partial-match) vendor aggregation only, per explicit decision.
- A dedicated `/vendors` page -- explicitly not built.
- Aggregation shapes other than "spend by vendor, optionally by date range" (e.g. by
  customer, by tax amount, spend with no vendor filter at all).
- Currency conversion -- mismatches are flagged, not converted/summed.
