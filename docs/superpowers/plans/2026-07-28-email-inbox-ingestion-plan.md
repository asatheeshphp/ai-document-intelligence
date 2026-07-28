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
`data/incoming/`, records each email via the existing `Email` model, and calls the
existing `DocumentIngestionService.processLocalDocument` per attachment — no extraction/
chunking/embedding logic is duplicated. A new `POST /api/email/check-inbox` endpoint is
the manual trigger. All mailbox settings are per-developer env vars.

**Tech stack:** `imapflow` + `mailparser` (new deps), TypeScript/Node (existing app),
Vitest (existing test runner), the existing `Email` model (no schema changes).

**Reference spec:** `docs/superpowers/specs/2026-07-28-email-inbox-ingestion-design.md`

**Known risk, not hidden:** this plan assumes IMAP with an app password works against a
real M365 `techgrit.com` mailbox. If a developer's tenant has legacy IMAP auth disabled
with no app-password fallback, Task 7 (live verification) will fail for them specifically,
and Microsoft Graph OAuth becomes a separate, larger follow-up plan — not something to
build speculatively now.

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
      `EMAIL_ATTACHMENT_DIR` (default `"data/incoming"`) — as a **separate** schema/parse
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

- [ ] Generate an app password for a real `techgrit.com` (or test) M365 account; confirm
      it's reachable via IMAP at all before assuming Task 3 will work end-to-end for it.
- [ ] Set the new env vars in `.env.local`, send a real test email with a PDF attachment
      to that mailbox.
- [ ] `curl -X POST http://localhost:3000/api/email/check-inbox`; confirm: the attachment
      exists in `data/incoming/`, an `Email` row and a fully-extracted `Invoice` exist,
      and the source message is now marked read in the actual mailbox.
- [ ] Call the endpoint again with no new unread mail; confirm a clean
      "0 new emails" result, not a re-download or duplicate `Email` row.
- [ ] Send a test email with a non-PDF/image attachment (e.g. `.docx`); confirm it's
      correctly ignored without erroring the call.
- [ ] With two unread test emails present, confirm one `checkInbox()` call processes only
      the older one (by UID) and leaves the newer one unread; a second call picks up the
      newer one (see Task 10).
- [ ] **If IMAP connection fails at this step** (tenant blocks legacy auth): stop, report
      the failure precisely (what error, at what step), and treat Microsoft Graph OAuth as
      a new, separate spec/plan — do not attempt to force IMAP to work around a
      server-side policy block.

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

---

## Out of scope for this plan (explicit)

- Microsoft Graph API / OAuth (only if Task 7 proves IMAP blocked)
- Scheduled/background polling
- Attachment types beyond PDF/image
- Sender filtering (subject filtering is now in scope — see Task 9)
- Any mailbox write operation beyond marking a message `\Seen`
