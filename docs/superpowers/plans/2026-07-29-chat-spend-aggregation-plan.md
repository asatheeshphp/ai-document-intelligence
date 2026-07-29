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

---

## Out of scope for this plan (explicit)

- Semantic/fuzzy vendor-category matching (e.g. "shipping companies") -- exact
  (partial-match) vendor aggregation only, per explicit decision.
- A dedicated `/vendors` page -- explicitly not built.
- Aggregation shapes other than "spend by vendor, optionally by date range" (e.g. by
  customer, by tax amount, spend with no vendor filter at all).
- Currency conversion -- mismatches are flagged, not converted/summed.
