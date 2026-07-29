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

- [x] Added `detectChatIntent(question, model?): Promise<ChatIntentOutcome>` in
      `services/ollama.service.ts`, following the exact reasoning-then-`ANSWER:`-line
      pattern already proven reliable for `classifyDocument`.
- [x] Prompt (`buildChatIntentPrompt`) asks for `AGGREGATION` (with `vendor="..."`,
      optional `from=`/`to=`) or `RETRIEVAL` on the final line.
- [x] Parser (`parseChatIntentResponse`/`CHAT_INTENT_PATTERN`) handles vendor/date
      fields being present or absent independently, and takes the LAST match in the
      response (same defensive reasoning as the classification parser).
- [x] 5 unit tests added: full range, vendor-only, RETRIEVAL, unparseable response,
      preamble-before-answer-line. All passing.

### Task 2: Vendor spend aggregation query

**Files:** `repositories/processing.repository.ts`, `services/spend-query.service.ts`
(new), `services/spend-query.service.test.ts` (new)

- [x] Added `ProcessingRepository.getVendorSpendSummary({ vendorNamePattern, dateFrom?,
      dateTo? })` — MongoDB `$match` on `vendorName` (case-insensitive regex, matching
      `SearchService`'s existing vendor-filter pattern) + optional `invoiceDate` range,
      `$group` summing `totalAmount` and counting documents. Returns `null` when no
      invoices match.
- [x] Returns `vendorNames: string[]` and `currencies: string[]` (every distinct value
      seen, not just the first) so the caller can flag a loose-pattern multi-vendor
      match or a currency mismatch rather than silently picking one.
- [x] `SpendQueryService.getVendorSpendSummary(...)` added as its own service, parsing
      the plain `"YYYY-MM-DD"` date strings from intent detection into `Date` objects
      (inclusive of the full end day for `dateTo`).
- [x] No dedicated repository test added -- confirmed no repository in this codebase has
      ever had one (services are tested with an injected repository mock; actual DB
      behavior is verified live). Followed that existing convention rather than
      introducing a new one; the real aggregation pipeline was verified live in Task 5
      instead, cross-checked against a direct DB query.
- [x] 3 unit tests for `SpendQueryService` (date parsing, no-date-range passthrough,
      null-on-no-match). All passing.

### Task 3: Wire into `RagService.answer()`

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts` (new)

- [x] Forked at the top of `answer()`: calls `detectChatIntent` first (wrapped in
      `.catch(() => null)` so a failed call falls through to retrieval, not an error).
      On `AGGREGATION` with a vendor, calls `SpendQueryService`; the answer comes from
      `formatSpendAnswer`, a fixed string template -- the model never touches the
      arithmetic or the final number.
- [x] `RagAnswer` gained `mode: "computed" | "retrieved"`.
- [x] No vendor match found for an `AGGREGATION` question: falls through to the existing
      retrieval flow rather than dead-ending.
- [x] Mixed-currency match: flagged in the answer text rather than silently summed
      (see `formatSpendAnswer`'s currency-mismatch branch).
- [x] Existing retrieval flow unchanged for RETRIEVAL-classified questions -- same
      inputs/outputs as before, just with `mode: "retrieved"` added.
- [x] 6 unit tests added covering: real aggregation match, mixed-currency flagging,
      no-match fallback to retrieval, retrieval path unchanged, no-context answer,
      intent-detection network failure fallback. All passing.

### Task 4: UI

**Files:** `components/chat/ChatMessageBubble.tsx`, `app/chat/page.tsx`,
`app/api/chat/route.ts`

- [x] Small badge on assistant replies: "Computed from invoice records" (aggregation);
      the existing sources toggle relabeled "Retrieved from N source(s)" (was
      "Sources (N)").
- [x] Added a fourth example starter question: "How much have I paid Readylink?"
- [x] `app/api/chat/route.ts` passes `mode` through in the response (was previously
      dropped after `RagService.answer()`).

### Task 5: Live verification

- [x] `npx tsc --noEmit` clean; `npm test` at 110/111 (the 1 failure is the same
      pre-existing, unrelated missing-sample-PDF issue present since earlier in the
      session).
- [x] Asked `/chat` "How much have I paid Readylink?" — direct DB query first confirmed
      ground truth (3 invoices, ₹1,767.00 total); chat's answer matched exactly:
      *"You paid Readylink Internet Services Limited Rs. 1767.00 across 3 invoices."*,
      `mode: "computed"`.
- [x] Asked "Which invoices mention GST?" — unaffected, `mode: "retrieved"`, same
      grounded-citation behavior as before this change.
- [x] Asked about a nonexistent vendor ("Acme Widgets Inc") — correctly fell through to
      retrieval, which also correctly found nothing. Asked about "SuperStore" (partial
      name, real vendor is exactly "SuperStore" here) with a date range ("...in 2012") --
      direct DB query confirmed ground truth (2 invoices, 12737.25 total, no currency
      stored on either); chat's answer matched exactly, correctly omitting a currency
      symbol rather than showing "undefined".
- [x] Asked the Readylink spend question in Tamil ("நான் Readylink க்கு எவ்வளவு பணம்
      செலுத்தியுள்ளேன்?") — correctly detected as `AGGREGATION`, `mode: "computed"`,
      same correct total as the English version -- confirms intent detection isn't
      English-only.

### Task 6: Fix intent inconsistency and vendor-name mangling — found via ad-hoc live testing beyond Task 5's scripted cases

**Files:** `services/chat-intent.service.ts` (new), `services/chat-intent.service.test.ts`
(new), `services/rag.service.ts`, `services/rag.service.test.ts`,
`services/ollama.service.ts`, `services/spend-query.service.ts`,
`services/spend-query.service.test.ts`

- [x] Asking "How much have I paid Express Cargo?" (phrased identically to the
      already-verified Readylink/SuperStore questions) surfaced two distinct problems,
      each confirmed by direct investigation, not assumed:
      1. The model itself answered `RETRIEVAL` for this question on a single call,
         despite recognizing the identical pattern correctly for other vendors -- the
         same self-consistency failure mode already fixed once for document
         classification (see Task 13 of the email-inbox-ingestion plan).
      2. Once that was fixed, the model still sometimes extracted the vendor as
         `"ExpressCargo"` (no space) instead of `"Express Cargo"`, which silently failed
         the exact-regex match against the real space-containing `vendorName` and fell
         through to retrieval -- which then answered with a hallucinated, wrong total
         copied from an unrelated invoice.
- [x] Fix 1: new `ChatIntentService` wraps `detectChatIntent` with a 3-vote majority,
      mirroring `DocumentClassifierService` exactly. `RagService` now depends on
      `ChatIntentService` instead of calling `OllamaService.detectChatIntent` directly.
- [x] Fix 2: `buildChatIntentPrompt` explicitly instructs the model to preserve vendor
      spacing exactly; `SpendQueryService` additionally builds a whitespace-tolerant
      regex pattern (strips whitespace from the extracted text, rejoins each character
      with an optional `\s*`) so `"ExpressCargo"` and `"Express Cargo"` produce an
      identical, correctly-matching pattern regardless of which one the model returns --
      a prompt fix alone isn't a guarantee, same lesson as the date-parsing fix earlier
      this session.
- [x] Unit tests added: `ChatIntentService`'s majority-vote behavior (5 tests, mirroring
      `document-classifier.service.test.ts`); `SpendQueryService`'s whitespace-tolerant
      pattern building (3 new tests, plus 1 existing test updated since the transform
      now runs on every pattern, not just ones with spaces); `RagService`'s tests updated
      to inject a mocked `ChatIntentService` instead of mocking `detectChatIntent`
      directly.
- [x] Live-verified: "How much have I paid Express Cargo?" now correctly returns
      `mode: "computed"` with the exact real total (45810, cross-checked directly
      against the database) -- matching the reliability already established for
      Readylink and SuperStore.

### Task 7: Fix numeric hallucination via misattribution — found via ad-hoc live testing beyond Task 6's scripted cases

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`

- [x] Live testing surfaced a distinct, deeper bug than Task 6's: asking "how much paid
      for logistics?" and "how much paid for internet 2026?" both returned a wrong
      dollar figure (`4148.2`) that was real but belonged to an unrelated SuperStore
      invoice, not the one the answer named. Confirmed this wasn't fabrication from
      nothing -- the model borrowed a genuine number that existed elsewhere in the
      retrieved context.
- [x] Root cause 1 (data hygiene): 3 of 6 documents in the live database were leftover
      test-duplicate copies from earlier duplicate-invoice-check testing, polluting
      retrieval rankings. Deleted via the existing document-delete endpoint after
      confirming with the user.
- [x] Root cause 2 (structural): `SearchService`'s `MAX_RESULTS_PER_INVOICE = 1` means
      only one chunk per invoice can appear in results. When that chunk was a header
      rather than the "payment" (totals) chunk, the model never saw the real number for
      that invoice at all -- so it reached for a plausible-looking figure from a
      different invoice's chunk that happened to also be in context.
- [x] Fix A -- `augmentWithPaymentChunks`: after search, for each distinct invoice
      already in the results, fetch its full chunk set (`findChunksByInvoiceId`) and
      append its "payment" chunk if one isn't already present. Additive only -- never
      replaces or reorders what search actually ranked.
- [x] Fix B -- `isAnswerGrounded`: before returning a retrieval-mode answer, checks that
      every "significant" (>= 10) monetary figure the model stated actually appears in
      the SPECIFIC invoice's own full chunk text -- not just anywhere among all
      retrieved chunks, which could span several unrelated invoices. Confirmed a naive
      "does this number appear anywhere in context" check would have been insufficient:
      `4148.2` was present in the overall retrieved context but not in the Express Cargo
      invoice's own chunks specifically. Only enforced when the answer names exactly one
      invoice (by vendor name or invoice number substring) -- skipped for 0 or 2+ named
      invoices to avoid false positives on legitimate multi-invoice list-style answers.
      Falls back to a new `UNGROUNDED_ANSWER_FALLBACK` message rather than showing a
      wrong number.
- [x] `RagService` gained a 5th constructor dependency, `ProcessingRepository`. 5 new
      unit tests added (payment-chunk augmentation added/skipped, grounding fallback
      triggered/passed-through, multi-invoice answers skip the check); all existing
      tests updated to inject a mocked repository. 11/11 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 123/124 (the 1 failure is the same
      pre-existing, unrelated missing-sample-PDF issue noted in Task 5).
- [x] Live-verified against the real dev server: "What is the grand total on invoice
      27639?" now correctly returns `4148.2` (confirmed as that invoice's own Grand
      Total) with all 3 invoices' payment chunks visible as sources with
      `chunkType: "payment"` -- confirming the augmentation is working. "how much paid
      for logistics?" correctly returns the exact Express Cargo total (45810) via the
      aggregation path.

---

## Out of scope for this plan (explicit)

- Semantic/fuzzy vendor-category matching (e.g. "shipping companies") -- exact
  (partial-match) vendor aggregation only, per explicit decision.
- A dedicated `/vendors` page -- explicitly not built.
- Aggregation shapes other than "spend by vendor, optionally by date range" (e.g. by
  customer, by tax amount, spend with no vendor filter at all).
- Currency conversion -- mismatches are flagged, not converted/summed.
