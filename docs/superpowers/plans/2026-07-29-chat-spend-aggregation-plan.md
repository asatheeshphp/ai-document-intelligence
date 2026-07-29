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

---

## Out of scope for this plan (explicit)

- Semantic/fuzzy vendor-category matching (e.g. "shipping companies") -- exact
  (partial-match) vendor aggregation only, per explicit decision.
- A dedicated `/vendors` page -- explicitly not built.
- Aggregation shapes other than "spend by vendor, optionally by date range" (e.g. by
  customer, by tax amount, spend with no vendor filter at all).
- Currency conversion -- mismatches are flagged, not converted/summed.
