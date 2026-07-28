# Email Inbox Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read unread email from a configured mailbox (M365/`techgrit.com` for this team,
but IMAP-generic so any developer can point it at their own account), download PDF/image
attachments to a local folder, and feed each one through the existing
`DocumentIngestionService` pipeline — closing the first, currently-unbuilt stage of the
flow in `PROJECT_CONTEXT.md`.

**Architecture:** A new `EmailIngestionService` connects via IMAP (`imapflow` +
`mailparser`), searches for unread messages, downloads matching attachments to
`data/samples/` (originally a dedicated gitignored `data/incoming/`; changed per explicit
instruction — see Task 12), records each email via the existing `Email` model, and calls
the existing `DocumentIngestionService.processLocalDocument` per attachment — no
extraction/chunking/embedding logic is duplicated. A new `POST /api/email/check-inbox`
endpoint is the manual trigger. All mailbox settings are per-developer env vars.

**Tech stack:** `imapflow` + `mailparser` (new deps), TypeScript/Node (existing app),
Vitest (existing test runner), the existing `Email` model (no schema changes).

**Reference spec:** `docs/superpowers/specs/2026-07-28-email-inbox-ingestion-design.md`

**Known risk, materialized:** this plan assumed IMAP with an app password would work
against a real M365 `techgrit.com` mailbox. Live testing confirmed the tenant blocks app
passwords entirely (no option to generate one at all in the account security settings) —
IMAP itself connects fine, but no credential this app can present satisfies it. Per
explicit decision, rather than building Microsoft Graph OAuth, testing moved to a
different mailbox (Gmail, with an app password) for this POC; the `techgrit.com`/M365
question is unresolved and deferred, not solved.

---

## Prerequisites

- Access to a real `techgrit.com` (or any test) M365 mailbox to generate an app password
  and run live verification against.
- Confirm whether IMAP is reachable at all for that account before writing extensive code
  around it (a 5-minute manual IMAP client test, e.g. via a mail client or `openssl
  s_client`, saves discovering a blocked-protocol problem after the service is built).

---

### Task 1: Add `imapflow` and `mailparser` dependencies

**Files:** `package.json`

- [ ] `npm install imapflow mailparser`
- [ ] `npm install --save-dev @types/mailparser` (`imapflow` ships its own types)
- [ ] Confirm `npx tsc --noEmit` still passes with the new packages present but unused.

### Task 2: Add lazily-validated email env vars

**Files:** `config/env.ts`, `.env.local.example` (new)

- [ ] Add `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT` (default `993`), `EMAIL_IMAP_USER`,
      `EMAIL_IMAP_PASSWORD`, `EMAIL_IMAP_MAILBOX` (default `"INBOX"`),
      `EMAIL_ATTACHMENT_DIR` (default `"data/samples"` — see Task 12) — as a **separate** schema/parse
      call from the existing top-level `env`, so a missing email config doesn't block app
      boot for developers not using this feature yet (see design doc's reasoning).
- [ ] Write `.env.local.example` documenting every var (existing ones too, for a complete
      reference) with placeholder values and a short comment on generating an M365 app
      password.
- [ ] Unit test: calling the lazy email-env accessor with required vars missing throws a
      clear error naming which variable is missing (mirrors the `E5Service` "surface it
      clearly" fix already shipped).

### Task 3: `services/email-ingestion.service.ts` — IMAP connection + unread search

**Files:** `services/email-ingestion.service.ts` (new), matching test file

- [ ] `connectAndSearchUnread()`: connects via `imapflow`, opens the configured mailbox,
      searches `UNSEEN`, returns raw message UIDs/sources for the next stage. Constructor
      takes the IMAP client as an injectable dependency (mirrors existing service patterns
      — pass a fake object in tests, don't `vi.mock` the class).
- [ ] Unit tests with a mocked IMAP client covering: no unread messages, several unread
      messages, a connection failure (surfaced with a clear message, not a raw
      network-error string).

### Task 4: Parse messages and filter attachments

**Files:** `services/email-ingestion.service.ts`, test file

- [ ] For each fetched message, parse via `mailparser` into headers (`messageId`, `from`,
      `subject`, `date`) + attachments.
- [ ] Filter attachments to PDF/image (`.pdf`, `.jpg`, `.jpeg`, `.png`) by MIME type/
      filename extension; anything else is dropped, not recorded as an error.
- [ ] Unit tests: a message with one matching PDF, one with a mix of matching + non-
      matching attachments (only the matching ones kept), one with zero matching
      attachments (whole message skipped downstream, still marked read).

### Task 5: Download attachments + record `Email` + trigger ingestion

**Files:** `services/email-ingestion.service.ts`, `repositories/processing.repository.ts`
(if a new helper method is needed), test file

- [ ] Write each matching attachment to `EMAIL_ATTACHMENT_DIR`, named
      `${messageUid}-${originalFilename}` to avoid collisions.
- [ ] Create the `Email` record via the existing repository (`messageId`,
      `senderAddress`, `subject`, `receivedAt`, `source: "INBOX"`). Rely on the existing
      unique index on `messageId` for dedup — catch the duplicate-key error and treat it
      as "already recorded," same pattern as `upsertDocumentBySourcePath`.
- [ ] For each downloaded attachment, call the existing
      `DocumentIngestionService.processLocalDocument({ sourcePath, filename, metadata: {
      emailId } })` — reuse, do not reimplement.
- [ ] Mark the message `\Seen` after attachments are written to disk (not after full
      extraction) — see design doc's reasoning.
- [ ] Catch and record per-message failures on that message's `Email.status`/`lastError`
      without aborting the rest of the batch.
- [ ] Unit tests: successful full flow (mocked downstream `DocumentIngestionService`);
      duplicate `messageId` handled gracefully; one message failing doesn't stop
      processing of the next one in the same batch.

### Task 6: `POST /api/email/check-inbox` endpoint

**Files:** `app/api/email/check-inbox/route.ts` (new)

- [ ] Calls `EmailIngestionService.checkInbox()`, returns
      `{ success, emailsScanned, emailsWithAttachments, documentsIngested, errors }`.
- [ ] Same try/catch-to-500-with-message pattern as the existing `/api/documents/ingest`
      route.
- [ ] Integration-style test (mocked service) confirming the response shape.

### Task 7: Live verification against a real mailbox

- [x] Attempted against a real `techgrit.com` M365 account first. Confirmed IMAP itself
      connects (`AUTHENTICATE PLAIN` reached the server), but the tenant blocks app
      passwords entirely — no "App password" option exists in the account's security
      settings (Authenticator/hardware token/phone only). Per the stop-and-report
      instruction below, did not attempt to force it; moved to a different mailbox.
- [x] Switched to a personal Gmail account with a generated app password, per explicit
      decision — see the plan header's "Known risk, materialized" note. `techgrit.com`
      remains untested and unresolved.
- [x] Set the env vars in `.env.local`, sent a real test email with a PDF attachment
      (plus, incidentally, 3 inline signature images) to that mailbox.
- [x] `curl -X POST http://localhost:3000/api/email/check-inbox`; confirmed: the real
      invoice PDF landed in `data/samples/`, was correctly classified and extracted
      (`documentsIngested: 1`, no errors), and the source message was marked read in the
      actual mailbox. This run is also what surfaced the inline-image issue fixed in
      Task 11.
- [ ] Call the endpoint again with no new unread mail; confirm a clean "0 scanned" result,
      not a re-download or duplicate `Email` row.
- [ ] Send a test email with a non-PDF/image attachment (e.g. `.docx`); confirm it's
      correctly ignored without erroring the call.
- [ ] With two unread test emails present, confirm one `checkInbox()` call processes only
      the newer one (by UID) and leaves the older one unread; a second call picks up the
      older one (see Task 10).
- [x] **IMAP connection failed for the M365 account** (tenant blocks app passwords
      entirely): stopped, reported the failure precisely (`AUTHENTICATE failed`, app
      password unavailable in account settings), and did not attempt to force a
      workaround — matches the instruction below exactly.

### Task 8: Documentation

**Files:** `README.md`

- [ ] Add a setup section: generating an M365 app password, the new env vars, and the
      `check-inbox` endpoint, following the same structure as the existing E5-sidecar/
      Ollama sections.

### Task 9: Optional subject filter — added after initial build, per explicit request

**Files:** `config/email-env.ts`, `services/email-ingestion.service.ts`, both test files,
`.env.local.example`, `README.md`, spec doc

- [x] Add `EMAIL_SUBJECT_FILTER` (optional, no default — unset preserves the original
      "every unread message with a matching attachment is a candidate" behavior).
      Commit `e6e0cd5`.
- [x] A message whose subject doesn't contain the filter (case-insensitive substring,
      anywhere — not a prefix match) is marked read and skipped, same treatment as a
      message with no matching attachment.
- [x] Unit tests: filter unset (unchanged behavior, covered by Task 5's existing tests);
      subject doesn't match (skipped, not recorded); subject matches case-insensitively
      anywhere in the string (processed normally).
- [x] `.env.local.example`, `README.md` step 8, and the design doc's Task 1/out-of-scope
      sections updated to document the new var and reflect that subject filtering is now
      in scope (previously explicitly deferred).

### Task 10: Limit each trigger call to one message — added after initial build, per explicit request

**Files:** `services/email-ingestion.service.ts`, test file, spec doc

- [x] `checkInbox()` now processes at most one message per call: the unread message with
      the highest UID (newest), sorted explicitly rather than trusting IMAP search-result
      ordering. Processes that one message whatever it is, even if it doesn't qualify
      (wrong subject, no attachment) — not "keep scanning until one qualifies." The rest
      of the unread messages are left untouched for the next call. Initially built
      oldest-first, switched to newest-first during live testing so a just-sent test
      email is picked up immediately instead of waiting behind an existing unread
      backlog.
- [x] `emailsScanned` in the result is now `0` or `1`, never a larger batch count.
- [x] Unit tests: multiple unread UIDs returned out of order — confirms only the highest
      is fetched/processed and the others are never touched; a failure on the one
      processed message is still recorded in `errors` without throwing.
- [x] Design doc's Task 1 section and Verification list updated to describe one-message-
      per-call semantics instead of batch processing.

### Task 11: Exclude inline images from attachment matching — found during live testing

**Files:** `services/email-ingestion.service.ts`, test file, spec doc

- [x] Live test against the real mailbox (Gmail, after the M365 tenant blocked app
      passwords entirely) surfaced a real problem: one real email had 3 tiny inline
      signature/logo PNGs (`contentDisposition: "inline"`) alongside the genuine invoice
      PDF. All 4 were downloaded and pushed through full extraction — including 3 slow
      vision-OCR calls on images that were never a real invoice.
- [x] `isMatchingAttachment` now also excludes any attachment with
      `contentDisposition === "inline"`, regardless of extension.
- [x] Unit test: an inline PNG and a real attached PDF in the same message — only the PDF
      is downloaded/ingested.
- [x] Design doc's attachment-filtering section updated with the live-testing evidence
      that motivated this.

### Task 12: Move attachment storage from a dedicated gitignored folder to `data/samples/` — added after initial build, per explicit request

**Files:** `config/email-env.ts`, `config/email-env.test.ts`, `.gitignore`,
`.env.local.example`, `README.md`, spec doc, plan header

- [x] `EMAIL_ATTACHMENT_DIR` default changed from `data/incoming` to `data/samples`.
      `data/incoming/` and its gitignore rule removed entirely.
- [x] Consequence stated explicitly, not silently accepted: `data/samples/` is
      git-tracked, so real downloaded attachments (potentially real business/personal
      data) are now as committable as any other file in that folder — raised explicitly
      as a tradeoff before making the change; "no special handling, accept the risk" was
      the explicit decision.
- [x] Unit tests, `.env.local.example`, `README.md`, and the spec doc updated to describe
      `data/samples/` as the current (not `data/incoming/` as the historical) storage
      location.

---

## Out of scope for this plan (explicit)

- Microsoft Graph API / OAuth — Task 7 confirmed this tenant's IMAP is blocked (no app
  password option at all), so this is now a real, needed follow-up if `techgrit.com`
  access is ever required, not just a hypothetical. Still not built in this plan; testing
  moved to a different mailbox instead, per explicit decision.
- Scheduled/background polling
- Attachment types beyond PDF/image
- Sender filtering (subject filtering is now in scope — see Task 9)
- Any mailbox write operation beyond marking a message `\Seen`
