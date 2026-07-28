# AI Document Intelligence

Local-first invoice processing POC: ingest a PDF/scan/image, extract structured data via
a local LLM, embed and chunk it, and search across invoices with hybrid semantic +
keyword + date-scoped search. Everything runs locally — no cloud AI services required.

For the current search/embedding architecture and design decisions, see
`docs/superpowers/specs/2026-07-28-e5-hybrid-search-design.md` and
`docs/superpowers/plans/2026-07-28-e5-hybrid-search-plan.md`. For the email-inbox
ingestion feature (optional, see step 8 below), see
`docs/superpowers/specs/2026-07-28-email-inbox-ingestion-design.md`.

## Prerequisites

Install these before cloning:

- **Node.js 20+** and npm (project uses Next.js 16, React 19)
- **MongoDB** running locally (or reachable) — e.g. [MongoDB Community
  Server](https://www.mongodb.com/try/download/community), or `docker run -d -p
  27017:27017 mongo`
- **[Ollama](https://ollama.com/download)** running locally, for LLM extraction/chat and
  vision-based OCR
- **Python 3.10+** and `pip`, for the E5 text-embedding sidecar

## 1. Clone and install Node dependencies

```bash
git clone <this-repo-url>
cd ai-document-intelligence
npm install
```

## 2. Configure environment variables

Copy `.env.local.example` to `.env.local` (this file is gitignored — never commit it) and
fill in your own values:

```bash
cp .env.local.example .env.local
```

At minimum:

```bash
NODE_ENV=development
PORT=3000

MONGODB_URI=mongodb://127.0.0.1:27017/ai_document_intelligence

OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_CHAT_MODEL=qwen2.5:1.5b
OLLAMA_EMBED_MODEL=nomic-embed-text
```

Adjust `MONGODB_URI` if your MongoDB isn't running on the default local port. `OLLAMA_EMBED_MODEL` is a legacy/fallback setting — text embeddings actually go through the E5 sidecar (step 4), not Ollama; it's kept only because `OllamaService` still has an unused reference implementation. Two more variables have working defaults and don't need to be set unless you want to override them: `OLLAMA_VISION_MODEL` (default `qwen2.5vl:7b`) and `E5_SERVICE_URL` (default `http://127.0.0.1:8001`).

## 3. Pull the required Ollama models

```bash
ollama pull qwen2.5:1.5b
ollama pull qwen2.5vl:7b
```

Make sure Ollama is running (`ollama serve`, or the desktop app) before starting the app.
Note: `qwen2.5vl:7b` (vision/OCR fallback for scans and images) is slow on CPU-only
machines — budget several minutes per page the first time it's exercised.

## 4. Set up and run the E5 embedding sidecar

This is a separate Python process — it is **not** managed by the Next.js app and must be
started independently, alongside Ollama and MongoDB.

```bash
cd e5-service
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8001
```

The first run downloads the `intfloat/multilingual-e5-base` checkpoint from HuggingFace
(cached locally afterward — subsequent starts are fast). Leave this running in its own
terminal. Verify it's up:

```bash
curl http://127.0.0.1:8001/health
# {"status":"ok","model":"intfloat/multilingual-e5-base","dimension":768}
```

## 5. Start MongoDB

If it isn't already running as a service, start it manually, e.g.:

```bash
mongod --dbpath <your-data-directory>
```

No manual schema/index setup is needed — Mongoose creates collections and indexes
automatically on first use against an empty database.

## 6. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). At this point you should have
**three processes running**: Ollama, the E5 sidecar (step 4), and `npm run dev`.

## 7. Verify the setup works end-to-end

Ingest one of the sample invoices already committed in the repo and confirm search
finds it:

```bash
curl -s -X POST http://localhost:3000/api/documents/ingest \
  -H "Content-Type: application/json" \
  -d '{"sourcePath":"data/samples/New folder/2.Sample_Logistics_Freight_Invoice.pdf"}'
```

A successful response includes `"success":true` and populated `extraction`/`invoice`
objects. Then search for it:

```bash
curl -s -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"delivery invoice"}'
```

Or just open [http://localhost:3000/search](http://localhost:3000/search) in the
browser and search there directly.

## 8. (Optional) Set up email inbox checking

Reads unread mail from a configured mailbox, downloads PDF/image attachments to
`data/incoming/`, and feeds each through the same ingestion pipeline as step 7 — no
separate extraction logic. This is optional; skip it if you're not using this feature.
Each developer configures their own mailbox — nothing mailbox-specific is hardcoded.

For a Microsoft 365 mailbox (e.g. a `techgrit.com` address), you need an **app
password**, not your normal login password — Microsoft disabled legacy IMAP basic auth
with the regular password for most tenants. Generate one at
[https://mysignins.microsoft.com/security-info](https://mysignins.microsoft.com/security-info)
("Add sign-in method" → "App password"), if your org's tenant allows it. If IMAP is
blocked entirely for your tenant, this feature won't connect — see
`docs/superpowers/specs/2026-07-28-email-inbox-ingestion-design.md` for why, and what the
fallback would look like.

Add to `.env.local` (already templated in `.env.local.example`):

```bash
EMAIL_IMAP_HOST=outlook.office365.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=you@techgrit.com
EMAIL_IMAP_PASSWORD=your-app-password
# EMAIL_SUBJECT_FILTER=invoice   # optional -- only process messages whose subject
                                 # contains this (case-insensitive); unset means every
                                 # unread message with a matching attachment qualifies
```

Then trigger a check manually (there's no background poller — call this endpoint
whenever you want to check for new mail):

```bash
curl -X POST http://localhost:3000/api/email/check-inbox
```

Response shape: `{ success, emailsScanned, emailsWithAttachments, documentsIngested,
errors }`. **Each call processes at most one message** — the newest unread message
(highest UID), whatever it is, even if it turns out to have no matching attachment or
fails the subject filter. `emailsScanned` is therefore always `0` or `1`, never a batch
count. Call the endpoint repeatedly (e.g. in a loop, or manually) to work through
several unread messages one at a time. A message is marked read once its attachments are
safely downloaded (or immediately, if it didn't qualify) — re-running the endpoint with
no unread mail left returns a clean "0 scanned" result.

## Troubleshooting

- **`ZodError: MONGODB_URI ... expected string, received undefined`** — `.env.local` is
  missing or not in the project root. Next.js only reads it from there automatically;
  running one-off scripts via `tsx` needs it passed explicitly (see below).
- **Search returns empty for everything** — check the E5 sidecar is actually running
  (`curl http://127.0.0.1:8001/health`); `search.service.ts` embeds every query through
  it, so if it's down, search silently returns no results rather than erroring loudly.
- **Extraction/classification hangs or times out** — check `ollama list` shows both
  pulled models, and `ollama serve` is running. Vision extraction in particular can take
  minutes per page on CPU-only hardware — this is expected, not a bug.
- **`Email inbox checking is not configured: missing ...`** — one or more
  `EMAIL_IMAP_*` vars aren't set in `.env.local`; the error names exactly which ones.
- **Inbox check fails with an auth error** — if your M365 tenant has legacy IMAP basic
  auth disabled with no app-password fallback, this feature can't connect for you — see
  `docs/superpowers/specs/2026-07-28-email-inbox-ingestion-design.md`.
- **Running a one-off debug script with `tsx`** — env vars aren't loaded by default the
  way Next.js loads them; run with:
  ```bash
  npx tsx -r dotenv/config your-script.ts dotenv_config_path=.env.local
  ```

## Development

```bash
npm run lint        # ESLint
npx tsc --noEmit     # Type-check
npm test             # Vitest unit tests
```

**Note:** this project pins a version of Next.js with breaking changes from what you may
know — see `AGENTS.md` before making framework-level changes; it points to
`node_modules/next/dist/docs/` for the current API surface.
