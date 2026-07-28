# Email Inbox Ingestion — Design

## Context

The original application flow (`PROJECT_CONTEXT.md`) starts with "Email Inbox → Read
unread emails → Download PDF attachments → Store attachment metadata → Extract PDF
text → ...". Every stage after "Download PDF attachments" already exists and works
(`DocumentIngestionService.processLocalDocument`, exercised so far only via a local file
path or the E5/search work in `docs/superpowers/specs/2026-07-28-e5-hybrid-search-design.md`).
The email-reading and attachment-download stage has not been built at all — this is genuinely
new, not a gap in existing code.

**Mailbox:** the team's `techgrit.com` domain, hosted on Microsoft 365. This app will be
run and tested independently by multiple developers, each against their own mailbox — so
every mailbox-specific setting (host, credentials, folder) must be environment-configured
per developer, never hardcoded, following the existing `config/env.ts` pattern
(`MONGODB_URI`, `OLLAMA_BASE_URL`, etc. are already per-developer env vars).

**Auth decision:** Microsoft disabled legacy IMAP basic authentication for most M365
tenants in 2022 as a security policy change — this isn't a code choice, it's a mail-server
setting outside this app's control. Per explicit decision, this plan builds **IMAP with an
app password first** (each developer generates their own app password against their own
mailbox), because it's far simpler to build and configure per-developer than Microsoft
Graph OAuth (which would need an Entra ID app registration, possibly admin consent, and
per-developer client secrets/tokens). **Risk, stated explicitly, not glossed over:** if a
developer's tenant has legacy IMAP disabled and no app-password option, this will not
connect for them, and the fallback is Microsoft Graph API + OAuth — a materially bigger
piece of work, not attempted in this plan.

## Approach

### 1. `services/email-ingestion.service.ts` — new service

```ts
export class EmailIngestionService {
  async checkInbox(): Promise<EmailCheckResult>
}
```

- Connects via IMAP (library: `imapflow` — modern, promise-based, actively maintained;
  `mailparser` to parse fetched messages into headers + attachments).
- Searches the configured mailbox folder for **unread (`UNSEEN`)** messages, then takes
  only the **single oldest one (lowest UID)** — added after initial build, per explicit
  request. One `checkInbox()` call processes at most one message, whatever it is, even if
  it doesn't qualify (wrong subject, no matching attachment) — it is not "keep scanning
  oldest-first until something qualifies." The rest of the unread messages are left
  untouched (still unread) and picked up on subsequent calls, one at a time. This
  naturally avoids reprocessing the same message on every manual trigger once it's marked
  read, and keeps each trigger call's work bounded and predictable.
- For the one message picked:
  - If `EMAIL_SUBJECT_FILTER` is set, only messages whose subject contains it
    (case-insensitive substring match, not a prefix) are considered — added after initial
    build, per explicit request, once real usage showed every unread message being a
    candidate was too broad. Unset (the default) means every unread message is still a
    candidate, preserving today's behavior. A non-matching message is marked read and
    skipped, same treatment as one with no matching attachment below — not an error.
  - Parses attachments; keeps only PDF and image (`.jpg`/`.jpeg`/`.png`) attachments —
    matches what `DocumentIngestionService` already supports end to end. Anything else
    attached is ignored, not downloaded, not recorded as an error.
  - If there are no PDF/image attachments, marks the message read and moves on — this
    email carried nothing this app can act on, not a failure.
  - If there are matching attachments, writes each one to a local folder
    (`EMAIL_ATTACHMENT_DIR`, default `data/incoming/`), one file per attachment, named to
    avoid collisions (e.g. `${messageUid}-${originalFilename}`).
  - Creates an `Email` record (existing model, no schema change) with `messageId` = the
    IMAP message's `Message-Id` header, `source: "INBOX"`, sender/subject/receivedAt from
    the parsed headers. `messageId` already has a unique index — if a message is somehow
    seen twice (e.g. a retry after a partial failure), the second attempt hits the unique
    constraint and is treated as "already recorded," not duplicated. Same atomic-dedup
    reasoning as the existing `upsertDocumentBySourcePath` pattern.
  - For each downloaded attachment, calls the **existing**
    `DocumentIngestionService.processLocalDocument({ sourcePath, filename, metadata: {
    emailId } })` — this is the same call the local-file path already uses; nothing about
    extraction, classification, chunking, or embedding is duplicated or reimplemented.
  - Marks the message read (`\Seen`) only after its attachments have been downloaded to
    disk (not after full extraction succeeds) — so a slow/failed *extraction* doesn't cause
    the same email to be re-fetched and re-downloaded every time `checkInbox` runs; the
    `Email.status`/`lastError` fields (already on the model) carry extraction-level
    failure, which is retryable independently via the same mechanism
    `reextractDocument` already uses for local-file documents.
  - Any failure processing that message (parse error, attachment write failure) is caught
    and returned in the result's `errors` array rather than throwing out of
    `checkInbox()` — a bad message on the failing path is recorded, not a crash.

### 2. `app/api/email/check-inbox/route.ts` — new manual-trigger endpoint

```ts
POST /api/email/check-inbox
```

- Calls `EmailIngestionService.checkInbox()`, returns a summary: emails scanned, emails
  with matching attachments, documents successfully ingested, per-message errors.
- Manual trigger, not a background poller — matches the explicit decision to keep this a
  POC-simple "call it when you want to check" endpoint rather than adding a scheduler
  process (a fourth long-running process alongside Ollama/E5/MongoDB) for a
  not-yet-needed automation requirement.

### 3. `config/env.ts` — new env vars, all per-developer

```ts
EMAIL_IMAP_HOST: z.string(),
EMAIL_IMAP_PORT: z.coerce.number().default(993),
EMAIL_IMAP_USER: z.string(),
EMAIL_IMAP_PASSWORD: z.string(),
EMAIL_IMAP_MAILBOX: z.string().default("INBOX"),
EMAIL_ATTACHMENT_DIR: z.string().default("data/incoming"),
```

All optional-with-defaults except host/user/password, which are required only when
`checkInbox` is actually called (not at app boot) — a developer who never touches this
feature shouldn't be blocked from running the rest of the app without an email account
configured. Achieved by **not** adding these to the top-level `schema.parse(process.env)`
call that runs at import time; instead `EmailIngestionService` validates its own required
env vars lazily, on `checkInbox()`, with a clear error naming exactly which variable is
missing — same "surface it clearly" principle just applied to `E5Service`'s connection
error.

### 4. `data/incoming/` — new local folder for downloaded attachments

- Gitignored (mirrors how `.env*` is gitignored) — these are real downloaded attachments,
  potentially containing real business data, not sample fixtures like `data/samples/`.
- Kept separate from `data/samples/` so the two are never confused: `samples/` is
  committed test fixtures, `incoming/` is real runtime output.

## Files touched

- `services/email-ingestion.service.ts` (new)
- `app/api/email/check-inbox/route.ts` (new)
- `config/env.ts` (new optional email vars, validated lazily — see above)
- `.env.local.example` (new — documents the required email vars without committing real
  credentials; see Verification)
- `.gitignore` (add `data/incoming/`)
- `README.md` (document the new endpoint + env vars + IMAP app-password setup)
- `package.json` (add `imapflow`, `mailparser`, and their `@types` packages)

No changes to `models/email.model.ts` — the existing schema already fits.

## Out of scope for this phase (explicit)

- Microsoft Graph API / OAuth — only attempted if IMAP app-password access is confirmed
  blocked on a real `techgrit.com` mailbox; not built speculatively.
- Scheduled/background polling — manual trigger only, per explicit decision.
- Any attachment type beyond PDF/image — matches existing extraction capability, not
  arbitrarily expanded.
- Sender filtering — not requested; every sender is treated equally.
- Marking non-matching unread mail read is in scope (see above) but deleting/moving
  emails, or writing back to the mailbox in any way beyond the `\Seen` flag, is not.

## Verification

1. `npx tsc --noEmit` clean; unit tests for `EmailIngestionService` with a mocked IMAP
   client (same mocking approach as existing services — pass a fake object to the
   constructor, not module-level `vi.mock`).
2. A committed `.env.local.example` documents every new env var with a placeholder value
   and a comment on how to generate an M365 app password, so a new developer knows what to
   fill in without needing to ask.
3. Live test against a real `techgrit.com` mailbox (app password generated first): send a
   test email with a PDF attachment to that mailbox, call `POST
   /api/email/check-inbox`, confirm the attachment lands in `data/incoming/`, an `Email`
   record and a fully-processed `Invoice` exist, and the message is marked read.
4. Confirm calling the endpoint a second time with no new unread mail returns a clean
   "0 new emails" result rather than reprocessing the same message.
5. Confirm a non-PDF/image attachment (e.g. a `.docx`) on a test email is correctly
   ignored without downloading it or erroring the call.
6. With two unread test emails present, confirm one `checkInbox()` call processes only
   the older one (by UID) and leaves the newer one unread; a second call then picks up
   the newer one.
