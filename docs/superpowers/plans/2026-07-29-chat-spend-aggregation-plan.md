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

### Task 8: Fix topical/premise hallucination — found via live re-testing after Task 7's numeric-grounding fix

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`, `utils/lexical-score.ts`

- [x] Task 7's numeric-grounding check didn't fully close the gap: re-testing "how much
      paid for internet 2026?" after that fix still returned a confident, wrong answer
      -- naming Express Cargo (an unrelated logistics invoice) as "the relevant invoice"
      and stating its real, genuine total. The number itself wasn't misattributed (it
      really is that invoice's own total), so the numeric check passed it. The premise
      was wrong: "internet" never appears anywhere in that invoice's own content at all.
- [x] Fix: a premise-grounding check, folded into the same single-named-invoice
      verification step as the numeric check (same trigger, same shared chunk fetch --
      no extra DB round trip). Reuses `lexicalOverlapScore` from `utils/lexical-score.ts`
      (already relied on by `SearchService`'s own lexical boost, so no new/untested
      logic): if the question is plain ASCII and has at least one meaningful token, and
      none of its meaningful words appear anywhere in the named invoice's full chunk
      text, the answer is replaced with a distinct fallback message rather than trusting
      the model's claim.
- [x] Deliberately skipped for non-English questions -- `SearchService`'s own
      translation-fallback note documents that a genuine non-English query can correctly
      match an invoice with zero literal word overlap; applying this check there would
      have broken the Tamil/Telugu recall already verified in Task 5.
- [x] No changes to `SearchService` at all -- ranking, thresholds, `MAX_RESULTS_PER_INVOICE`,
      and the multilingual translation fallback are untouched. This is purely an
      additional post-answer verification layer in `RagService`, so no existing search
      query's behavior changed.
- [x] Added `hasMeaningfulTokens` export to `utils/lexical-score.ts` (distinguishes "no
      meaningful words to check" from "words existed but didn't match" -- only the
      latter should reject).
- [x] 4 new unit tests: reproduces the exact reported bug (rejected), a genuinely-matching
      English question (passes through), a non-ASCII question with zero overlap (passes
      through, protecting multilingual recall), plus fixed an existing test whose mock
      invoice chunk set was unrealistically thin (payment chunk only, no header/vendor
      text) and would have false-failed the new check -- corrected to include a header
      chunk, matching real `findChunksByInvoiceId` shape. 14/14 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 126/127 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "how much paid for internet 2026?" now
      returns the safe premise-mismatch fallback instead of a wrong claim. Re-confirmed
      "What is the grand total on invoice 27639?" still returns the exact correct figure
      (4148.2), and "how much paid for logistics?" still returns a genuinely-grounded
      figure from Express Cargo's own data.

### Task 9: Fix a substring false-match that silently defeated Task 8's premise check — found via ad-hoc live testing right after Task 8 shipped

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`, `utils/lexical-score.ts`

- [x] Asking "get all internet related invoices" immediately after Task 8 still returned
      a confident wrong answer naming Express Cargo as "the only invoice related to
      Internet-related services" — the premise check that should have caught this
      didn't fire. Root cause debugged directly against the real invoice text (not
      assumed): Task 8's check reused `lexicalOverlapScore`'s raw substring matching,
      and the filler word "all" scored a false match purely because it's a substring of
      "allowance" in one of the invoice's own line items — that alone made the overlap
      score nonzero (0.25), silently passing the check even though "internet" (the
      question's actual subject) never appeared anywhere in the invoice.
- [x] Fix: the premise check now does its own word-boundary-aware matching (`\bword\b`)
      instead of reusing `lexicalOverlapScore`'s substring logic. Substring matching
      stays exactly as-is for `lexicalOverlapScore` itself and everything that depends on
      it (`SearchService`'s ranking boost) — untouched, so no existing search query's
      behavior changes. The fix is scoped entirely to this one veto check in
      `RagService`.
- [x] Added `extractMeaningfulTokens` export to `utils/lexical-score.ts` (reuses the
      same stopword/bare-year-filtered tokenizer already relied on for ranking, so no
      duplicated logic) so `RagService` can run its own boundary-matching predicate over
      the same token list rather than lexicalOverlapScore's fractional scoring.
- [x] 1 new regression test reproducing this exact case (a filler word that's a
      substring of an unrelated word in the invoice must not count as a match). 15/15
      `rag.service.test.ts` tests passing; all Task 7/8 tests re-verified still passing
      unchanged.
- [x] `npx tsc --noEmit` clean; `npm test` at 127/128 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "get all internet related invoices" and
      "how much paid for internet 2026?" both now correctly return the premise-mismatch
      fallback. Re-confirmed all previously-correct examples still work exactly as
      before: invoice 27639's grand total, the Express Cargo aggregation query (by name
      and by "logistics"), all unchanged.

### Task 10: STATUS_FILTER intent — answer "any unpaid invoices?" with real payment-status data

**Files:** `schemas/chat-intent.schema.ts`, `services/ollama.service.ts`,
`services/ollama.service.test.ts`, `services/chat-intent.service.ts`,
`services/chat-intent.service.test.ts`, `services/invoice-status-query.service.ts` (new),
`services/invoice-status-query.service.test.ts` (new), `services/rag.service.ts`,
`services/rag.service.test.ts`

- [x] "any unpaid invoices?" and "get unpaid invoices" both returned a generic
      non-answer via retrieval ("I couldn't find anything relevant..."). Confirmed via
      investigation: `paymentStatus`/`dueDate` are real fields on the invoice model
      (`models/invoice.model.ts`), already used by the existing `/api/invoices/due`
      reminders endpoint, but `services/rag.service.ts`, `chat-intent.service.ts`, and
      `spend-query.service.ts` had zero awareness of either field — payment status is
      metadata, not something semantic search over invoice text chunks can ever answer,
      structurally the same gap AGGREGATION was built to close for vendor-spend totals.
- [x] Added a third chat intent, `STATUS_FILTER`, alongside `AGGREGATION`/`RETRIEVAL`:
      `ChatIntentSchema` gained the type plus an optional `status: "PAID" | "UNPAID" |
      "OVERDUE"`; `buildChatIntentPrompt`/`CHAT_INTENT_PATTERN`/`parseChatIntentResponse`
      in `ollama.service.ts` extended to detect and parse it the same reasoning-then-
      `ANSWER:`-line way as the other two.
- [x] `ChatIntentService`'s majority-vote logic generalized from a 2-category to an
      N-category tally (`Map`-based counts) — with 3 categories now possible, a 3-vote
      split can be a genuine tie (1-1-1), unlike the old 2-category version where 3
      votes always had a clear winner. Ties, and any RETRIEVAL win, default to
      RETRIEVAL — an uncertain vote shouldn't gamble on presenting a computed
      number/list as fact.
- [x] New `InvoiceStatusQueryService.listByStatus(status)` — deliberately mirrors
      `app/api/invoices/due/route.ts`'s existing filter exactly (`paymentStatus: { $ne:
      "PAID" }` for UNPAID, handling legacy rows with no stored status the same way;
      `dueDate: { $ne: null, $lt: now }` added for OVERDUE; `paymentStatus: "PAID"` for
      PAID) so a chat question resolves to the same data that page's UI already
      surfaces, not a second, possibly-diverging definition.
- [x] Wired into `RagService.answer()`: `STATUS_FILTER` always answers directly from a
      fixed string template (`formatStatusFilterAnswer`, never LLM-touched, same
      `mode: "computed"` pattern as spend totals) — including the zero-results case
      ("I couldn't find any paid invoices" is a real, useful answer, not a
      fall-through-to-retrieval case, since status is a closed enum with no "vendor name
      might be slightly wrong" ambiguity to fall through on).
- [x] 12 new unit tests across the 4 files (STATUS_FILTER parsing, 3-category majority
      vote including the new tie-break case, `InvoiceStatusQueryService`'s filter shape
      per status, `RagService`'s computed-list and zero-results answers). 45/45 passing
      across the touched test files.
- [x] `npx tsc --noEmit` clean; `npm test` at 137/138 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server, cross-checked against a direct DB query
      (not just "the answer sounds right"): all 3 invoices are `PENDING` with only
      Express Cargo's `dueDate` (2026-07-22) stored and in the past. "any unpaid
      invoices?" and "get unpaid invoices" both correctly list all 3; "which invoices are
      overdue?" correctly lists only Express Cargo; "show me paid invoices" correctly
      returns "I couldn't find any paid invoices." All previously-verified
      AGGREGATION/RETRIEVAL/premise-check behavior re-confirmed unchanged.

### Task 11: Fix deterministic misclassification of "paid" (positive) status questions — found via live re-testing after Task 10 shipped

**Files:** `services/chat-intent.service.ts`, `services/chat-intent.service.test.ts`

- [x] "get the paid invoices" returned a generic RETRIEVAL non-answer. Debugged directly
      against the live model (not assumed): 5/5 identical calls all returned RETRIEVAL
      for this exact question -- a genuine, deterministic misclassification, not the
      random per-call disagreement majority voting exists to smooth over. Testing a
      range of phrasings found the boundary: "paid" (positive polarity) combined with
      certain shapes -- especially the article "the", or "list"/"show" without "get" --
      reliably misclassifies as RETRIEVAL, while "unpaid" and "overdue" questions
      classified correctly across every phrasing tried.
- [x] First attempt (adding more few-shot "paid" examples to the prompt) was tried and
      measured, live, to make things *worse* -- two previously-correct phrasings ("get
      all paid invoices", "which invoices have been paid?") flipped to wrong once more
      "paid" examples were added. Reverted. This confirms a genuine small-model capacity
      limit on this specific distinction, not a prompt-wording gap -- same lesson as
      `buildWhitespaceTolerantPattern` earlier this session: a prompt fix alone isn't a
      guarantee.
- [x] Fix: a deterministic keyword override in `ChatIntentService.detectIntent`, applied
      only when the model's own majority vote was RETRIEVAL (an already-STATUS_FILTER or
      AGGREGATION vote is left untouched). Matches "paid invoices" specifically used as
      the direct object of a listing verb/question (`get/list/show/find/display [the/
      all/my] paid invoices`, `which invoices have been paid?`, `any paid invoices?`) --
      not any sentence that merely mentions both words, so a genuine retrieval question
      like "Summarize the invoice from ABC that I already paid last month" correctly
      stays RETRIEVAL.
- [x] 3 new unit tests: the override firing on the reported case, the override NOT
      firing on the coincidental-mention edge case, and the override not touching an
      already-correct AGGREGATION vote. 44/44 passing across the touched test files.
- [x] `npx tsc --noEmit` clean; `npm test` at 140/141 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server, testing every previously-failing
      phrasing plus regression checks: "get the paid invoices" (fixed), "any unpaid
      invoices?", "which invoices are overdue?", "How much have I paid Readylink?" (still
      correctly finds nothing -- Readylink's invoices remain deleted from earlier
      test-data cleanup), and "What is the grand total on invoice 27639?" -- all
      unchanged and correct.

### Task 12: Attribute an answer to its invoice by stated numbers when the answer never names it — found via systematic debugging after Task 8/9

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`

- [x] "summarize the total computer invoice related amount" answered "$4,069.53 + $78.66
      = $4,148.20" (invoice 27639's own real numbers) without ever writing "SuperStore"
      or "27639" in the text. Root cause traced precisely (not assumed): replayed the
      exact answer through the real `RagService.answer()` and confirmed the fallback
      never triggered, then confirmed why -- `mentionsInvoice`-based attribution alone
      requires the answer to literally contain the vendor name or invoice number; a
      vaguely-worded answer finds zero named invoices, and per the existing design
      ("skipped for 0 or 2+ named invoices, to avoid false positives on multi-invoice
      list answers") a count of 0 was silently treated as nothing-to-verify, even though
      the sources conclusively show only one invoice was actually used.
- [x] Fix: `attributeInvoiceByNumbers` -- when text-based naming finds zero matches but
      the answer states significant numbers, identify the invoice by which one's own
      full text contains every one of those numbers. Only trusted when the match is
      unique; ambiguous (numbers fit 2+ invoices) or unattributable (numbers fit none)
      cases are left unattributed rather than guessing, matching the same
      asymmetric-risk philosophy as the existing 2+-named-invoices skip.
- [x] Explicit, documented limitation (not silently missed): "computer" genuinely is a
      real, literal word in invoice 27639's own text (`"Chromcraft Computer Table"` --
      a computer desk, not a computer) -- closing the coverage gap doesn't fix this
      specific example, since the premise check correctly finds the word lexically
      present. Distinguishing "word is present" from "topically relevant" needs real
      semantic understanding, which this check deliberately doesn't attempt. A
      dedicated test asserts this remains unchanged, so the limitation is an
      intentional, visible trade-off rather than a silent gap.
- [x] 4 new unit tests: the coverage gap closing for a genuine premise mismatch, the
      documented remaining literal-match limitation, ambiguous-attribution skip (numbers
      fit 2+ invoices), and unattributable skip (numbers fit none). 21/21 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 144/145 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: the exact reported "computer" example
      behaves exactly as the documented limitation predicts (unchanged). A synthetic
      case surfaced a SEPARATE, additional gap during this verification -- flagged to
      the user, not silently folded into this fix -- see the note below.
- [x] **Flagged, then fixed (see below)**: near-universal invoice-vocabulary words ("amount",
      "total") can still cause a false premise-pass even on a real, literal word match
      -- e.g. "summarize the electricity bill amount" named ABC Technologies' invoice and
      cited its real Installation Service line ($5,000), passing the premise check only
      because "amount" is a genuine word in that invoice's line items -- "electricity"
      itself never appears anywhere. Confirmed directly (regex check against the real
      invoice text). Same root shape as the already-fixed "all" ⊂ "allowance" bug, but
      this time it's a whole-word match on an extremely common, non-distinguishing
      invoice-domain word, not a substring collision -- likely fix is excluding words
      like "amount"/"total" from the premise check's vocabulary the same way
      "invoice"/"invoices" and bare years already are. Awaiting a decision on scope
      before building.
- [x] **Fixed.** Excluded near-universal payment/tax vocabulary ("amount", "total",
      "totals", "subtotal", "tax", "taxes", "charge", "charges", "due", "payment",
      "payments") from `utils/lexical-score.ts`'s shared `STOPWORDS` -- the same list
      already excluding "invoice"/"invoices" for the identical reason (near-universal
      across this corpus, not a real relevance signal). Scoped to the shared tokenizer
      rather than a rag.service.ts-local list, since these words are exactly as
      non-distinguishing for `SearchService`'s lexical-ranking boost as for the premise
      check -- one source of truth, and confirmed no existing search test relies on
      these words driving a match (they're all near-universal there too, so removing
      them reduces ranking noise rather than useful signal).
- [x] 2 new `lexical-score.test.ts` tests (generic vocabulary alone scores 0; a real
      keyword alongside generic vocabulary still scores correctly) + 1 new
      `rag.service.test.ts` regression test reproducing the exact live bug ("summarize
      the electricity bill amount" naming a real invoice/number but never mentioning
      electricity). 34/34 passing across both files.
- [x] `npx tsc --noEmit` clean; `npm test` at 147/148 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "summarize the electricity bill
      amount" no longer confidently misattributes to ABC Technologies' invoice (search
      itself now correctly finds nothing above threshold for this query, having lost the
      "amount"-driven lexical-boost noise). Re-confirmed regressions: invoice 27639's
      grand total, the "internet 2026" premise-mismatch fallback, and general search
      queries (`GST tax`, `grand total amount`) all unchanged and correct.

### Task 13: Distinguish a shared vendor name from a genuine multi-invoice answer

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`

- [x] "summarize the total computer invoice related amount" answered *"The total for the
      SuperStore computer invoices is $1,330.29"* -- traced precisely: the answer names
      only "SuperStore," which is the vendor for TWO different real invoices (24938 and
      27639). The old `mentionsInvoice` boolean check counted this as "2 invoices named"
      and skipped verification entirely -- the exact bypass meant to protect genuine
      multi-invoice list answers (e.g. "Vendor One and Vendor Two"), triggered instead
      by one vendor owning more than one invoice, a normal real-world situation this
      corpus already has.
- [x] Fix: attribution now groups matches by which literal identifier STRING the answer
      used (`matchedInvoiceIdentifier`, preferring invoice number over vendor name when
      both would match), not by how many invoice records matched. A shared vendor name
      matching multiple records is narrowed via `attributeInvoiceByNumbers`, scoped to
      just that vendor's own invoices, instead of being treated as "multiple invoices
      named." An answer naming 2+ genuinely distinct identifiers is still left alone,
      preserving the original safe skip for real multi-invoice answers.
- [x] 1 new unit test reproduces the exact shape of this bug and proves the narrowing
      catches a real mismatch that the old logic would have wrongly skipped (a shared
      vendor's number attributed to the wrong specific invoice for the customer asked
      about). Existing multi-invoice-skip and single-invoice tests re-verified
      unchanged. 23/23 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 148/149 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "What did Benjamin Farhat pay to
      SuperStore?" (ambiguous across SuperStore's two invoices) now correctly triggers
      the safe fallback instead of silently passing through. Re-confirmed the original
      "computer" example is unaffected by this fix specifically (still passes, per the
      already-documented literal-word-match limitation) and other regressions (invoice
      27639's total, the genuine 3-invoice GST list, unpaid-invoices list) unchanged.

### Task 14: Reject a fabricated invoice-number-shaped identifier, even when its attached figure is genuinely correct

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`

- [x] "The total logistics amount for Invoice INV-2026-2048 is 45,810 rupees" spliced the
      letter prefix of one real invoice ("INV-2026-001") onto the numeric suffix of a
      different real invoice ("EXL-2026-2048") -- a fabricated identifier matching
      nothing on file, even though 45,810 genuinely is the real Express Cargo invoice's
      total. Neither the premise check ("logistics" is a real word there) nor the
      numeric check (45810 is a real number there) could catch this -- the figure
      attributes cleanly, so both pass. This is the 5th narrow gap found in this same
      verification logic across Tasks 7/8/9/12/13; flagged to the user as a pattern
      worth naming before building a 6th narrow patch, and explicitly chosen as still
      the pragmatic move over a structural redesign at this scope.
- [x] Fix: `checkAnswerGrounding` now runs an identifier-shape check FIRST, unconditional
      on whether the answer is otherwise single- or multi-invoice shaped -- any
      invoice-number-SHAPED substring in the answer (letters-digits-digits, dash
      separated, matching this corpus's real invoice-number format) must equal a real
      invoice number among the retrieved results, or the answer is rejected outright.
      Deliberately narrow pattern (`extractInvoiceNumberShapedCandidates`) so it doesn't
      false-flag other legitimate identifier shapes already in this corpus -- a PO
      number ("PO-45879", single dash) or a multi-segment order ID
      ("IN-2012-BF1121558-40955") don't match the letters-digits-digits shape and are
      left alone.
- [x] 2 new unit tests: the exact reported bug (fabricated identifier rejected despite a
      correct dollar figure), and a true-negative case (a real invoice number plus a
      real PO number in the same answer, confirming neither is falsely flagged).
      25/25 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 150/151 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: the exact reported question now
      returns the new fabricated-identifier fallback. Re-confirmed invoice 27639's
      total is unaffected. Live testing surfaced one more small, DIFFERENT issue --
      noted, not fixed, since it's out of scope for this task: asked for ABC
      Technologies' "PO number", the model answered with its real invoice number
      (INV-2026-001) mislabeled as the PO number, instead of its actual real PO number
      (PO-45879). The identifier itself is genuine (correctly not flagged as
      fabricated) -- this is a semantic mislabeling / retrieval-coverage issue, a
      different problem than identifier fabrication.

### Task 15: Also guarantee the header chunk (PO number, due date) is in context, not just the payment chunk

**Files:** `services/rag.service.ts`, `services/rag.service.test.ts`

- [x] Asked for ABC Technologies' PO number, the model answered with its own invoice
      number (INV-2026-001) instead of the real PO number (PO-45879). Traced precisely,
      not assumed: the sources actually sent to the model were the "supplier" and
      "payment" chunks -- the "header" chunk, the ONLY chunk containing "PO Number:
      PO-45879", never made it into context at all, because a different chunk type won
      that invoice's single per-invoice ranking slot (`MAX_RESULTS_PER_INVOICE`). Lacking
      the real data, the model reused the only invoice-shaped identifier it had (its own
      citation label) as a plausible-looking guess -- same root shape as Task 7's
      original payment-chunk gap, different field.
- [x] Fix: generalized `augmentWithPaymentChunks` from guaranteeing one chunk type
      ("payment") to a small required set (`["payment", "header"]`) -- for each
      distinct invoice, whichever of these types is missing from the retrieved results
      gets fetched and appended, fetching each invoice's full chunk set once regardless
      of how many types are missing. Purely additive, as before -- never removes or
      reorders what search actually ranked.
- [x] Updated one existing test whose premise no longer held (asserted zero re-fetch
      when only the payment chunk was already present -- now also needs the header
      chunk present to skip fetching) and added 1 new test reproducing the exact
      reported bug (header chunk missing despite payment chunk present -- confirms the
      PO number reaches the actual prompt sent to the model, not just the sources list).
      8 existing test fixtures across the file needed a header-chunk mock's `_id` field
      added, now that header augmentation runs unconditionally alongside payment
      augmentation. 26/26 passing.
- [x] `npx tsc --noEmit` clean; `npm test` at 151/152 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "What is the PO number and grand total
      for the ABC Technologies invoice?" now correctly answers "PO-45879" (previously
      answered with the wrong, mislabeled invoice number). Re-confirmed invoice 27639's
      total and the "internet 2026" premise-mismatch fallback are unaffected.

### Task 16: LINE_ITEM_AGGREGATION intent — never let the model touch product/category totals or their arithmetic

**Files:** `schemas/chat-intent.schema.ts`, `services/ollama.service.ts`,
`services/ollama.service.test.ts`, `services/line-item-aggregation.service.ts` (new),
`services/line-item-aggregation.service.test.ts` (new), `services/rag.service.ts`,
`services/rag.service.test.ts`

- [x] "summarize the total computer invoice related amount" let the model pick a
      garbled per-unit-price fragment out of a line item's raw text ($1,330.29) and then
      do its own arithmetic on top of it -- "$1,330.29 * 3 = $4,000.87" doesn't even
      multiply correctly. Same root problem `AGGREGATION`/`STATUS_FILTER` already solve
      for vendor totals and payment status: never let the model compute or select a
      number freehand when a real, deterministic answer is available.
- [x] Added a 4th chat intent, `LINE_ITEM_AGGREGATION`, with an extracted `keyword`
      field (a product/category term, not a vendor) -- detected the same
      reasoning-then-`ANSWER:`-line way as the other three, majority-voted by the
      already-N-category-generalized `ChatIntentService`.
- [x] New `LineItemAggregationService.getLineItemTotal(keyword)`: searches
      `chunkType: "line_items"` chunks for the keyword via the existing `SearchService`
      (same calibrated thresholds as all other retrieval), then for each match parses
      that chunk's own already-extracted `"amount <value>"` field via regex --
      deliberately not qty × unit price, which isn't reliably consistent across this
      corpus's differently-formatted invoices. Sums those real values; the model never
      sees or touches the arithmetic. Flags mixed currencies the same way
      `SpendQueryService` already does for vendor totals.
- [x] Wired into `RagService.answer()` as a 4th computed path, same `mode: "computed"`
      pattern, falling through to retrieval if nothing matches.
- [x] **Found and fixed a regression during live verification, before considering this
      done**: "summarize the total logistics amount" -- previously correct via vendor-
      name matching (Express Cargo & Logistics Solutions) -- started giving a WRONG
      total once `LINE_ITEM_AGGREGATION` existed, because the model deterministically
      (3/3 identical calls) classified it as `LINE_ITEM_AGGREGATION` with a paraphrased
      keyword ("logistics services") instead of recognizing "Logistics" as literally
      part of a real vendor's name. Fix: before running line-item aggregation, try each
      meaningful word of the keyword individually against real vendor names first
      (word-by-word, since the model's paraphrased whole-phrase keyword doesn't
      literally match "Logistics Solutions") -- a real vendor-name match is a much
      stronger, unambiguous signal than a semantic keyword guess, so it's preferred
      regardless of which intent type the model picked.
- [x] Documented, not silently missed: live verification also surfaced that
      `SearchService`'s normal 0.8 retrieval threshold let one borderline (0.808) match
      ("Machines, Technology, TEC-MA-5498", scored against the query "computer" despite
      never mentioning the word) into the "computer" sum. Flagged to the user as a real
      precision-vs-recall question specific to aggregation (a financial total plausibly
      needs a higher confidence bar than "show me possibly-relevant results") --
      awaiting a decision on whether to raise the threshold specifically for this path.
- [x] 12 new unit tests across the 4 files (LINE_ITEM_AGGREGATION parsing, amount-field
      parsing incl. the exact garbled-fragment reproduction, multi-item summing, mixed-
      currency flagging, no-match fallthrough, and the vendor-name-collision fix with
      its own dedicated regression test). 30/30 passing in `rag.service.test.ts`.
- [x] `npx tsc --noEmit` clean; `npm test` at 162/163 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server (E5 sidecar confirmed restarted and
      healthy first, after an unrelated background-process stop mid-session): the exact
      reported "computer" bug is fixed (real deterministic sum, no model arithmetic);
      "summarize the total logistics amount" and "How much have I paid Express Cargo?"
      both correctly return the vendor total (45810.00) unaffected by the new intent.

### Task 17: Two classifier fixes — "payment condition" misclassification, and per-invoice status lookup

**Files:** `schemas/chat-intent.schema.ts`, `services/ollama.service.ts`,
`services/ollama.service.test.ts`, `services/chat-intent.service.ts`,
`services/chat-intent.service.test.ts`, `services/invoice-status-query.service.ts`,
`services/invoice-status-query.service.test.ts`, `services/rag.service.ts`,
`services/rag.service.test.ts`

- [x] **"What is the payment condition?"** classified as `STATUS_FILTER(PAID)` instead
      of `RETRIEVAL` -- confirmed live, deterministically (3/3): the model reads
      "condition(s)" as if it meant "status", when in ordinary invoice English "payment
      condition(s)" overwhelmingly means payment TERMS. Confirmed the boundary is
      specifically this word -- "payment terms?", "payment due date?", and "payment
      method?" all correctly stayed RETRIEVAL on the same live model. Fixed with a
      deterministic override in `ChatIntentService` (same pattern as the earlier "paid
      invoices" override, opposite direction): converts a STATUS_FILTER vote back to
      RETRIEVAL when the question matches the "payment condition(s)" phrase, scoped
      narrowly to that phrase so it doesn't affect any other STATUS_FILTER question.
- [x] **Conversational continuity, partially addressed**: after two turns discussing
      "EXL-2026-2048" specifically, "How much GST was charged?" silently answered about
      a different invoice. Added `RagService.buildContextAwareSearchQuery` -- nudges
      (does not filter) the search query toward the invoice named in the immediately
      prior turn when the current question doesn't name one itself, only when that
      turn names exactly one invoice (ambiguous or absent references leave the question
      untouched). Live-verified this correctly re-ranks the right invoice's own chunks
      to the top -- but also surfaced that the guaranteed-chunk-types list
      (`payment`/`header`) doesn't include `taxes`, so a GST-specific follow-up can
      still lack the right invoice's own tax breakdown. Flagged to the user, not yet
      built (adding `"taxes"` to that list is the natural next step, same shape as
      Tasks 7 and 15).
- [x] **"What is the payment status of invoice EXL-2026-2048?"** ran the same blanket
      "list every PAID invoice" query as "any paid invoices?" -- the invoice number was
      extracted but never used, discarded entirely, silently answering about the wrong
      thing (or nothing). Root cause: `STATUS_FILTER` only ever carried a `status`
      field, with nowhere for a named invoice to go. Fix: added an optional
      `invoiceNumber` field to the intent; `InvoiceStatusQueryService.getStatusForInvoiceNumber`
      looks up that one invoice directly and reports its REAL current status --
      deliberately ignoring whatever `status` the model guessed, since the question is
      asking what the status IS, not testing a guess.
- [x] Documented, not yet built: invoice-number extraction for this new field is
      phrasing-dependent, not simply bare-numeric-vs-alphanumeric -- "what is the
      payment status of invoice 27639?" extracts correctly, but "has invoice 27639 been
      paid?" and "is 27639 paid?" don't. The originally reported case (`EXL-2026-2048`,
      "what is the payment status of...") is fully fixed and live-verified; this is a
      narrower, separate prompt-coverage gap flagged for a future fix.
- [x] 8 new unit tests across the 4 files (payment-condition override + its
      no-false-positive guard, invoiceNumber parsing, `getStatusForInvoiceNumber`'s
      exact/case-insensitive matching + PENDING/overdue/PAID reporting + no-match case,
      the per-invoice RagService branch ignoring the guessed status, the
      context-aware-search-query nudge + its 3 no-op guard cases). 36/36 passing in
      `rag.service.test.ts`.
- [x] `npx tsc --noEmit` clean; `npm test` at 176/177 (same pre-existing, unrelated
      missing-sample-PDF failure noted in Task 5).
- [x] Live-verified against the real dev server: "what is the payment status of this
      invoice: EXL-2026-2048" now correctly answers "unpaid and overdue (due
      2026-07-22)", matching the real database record exactly. Re-confirmed "any unpaid
      invoices?" and the "payment condition" fix are both unaffected.

---

## Out of scope for this plan (explicit)

- Semantic/fuzzy vendor-category matching (e.g. "shipping companies") -- exact
  (partial-match) vendor aggregation only, per explicit decision.
- A dedicated `/vendors` page -- explicitly not built.
- Aggregation shapes other than "spend by vendor, optionally by date range" (e.g. by
  customer, by tax amount, spend with no vendor filter at all).
- Currency conversion -- mismatches are flagged, not converted/summed.
