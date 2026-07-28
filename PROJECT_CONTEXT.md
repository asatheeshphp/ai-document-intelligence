# AI Document Intelligence Platform - Project Context

## Project Vision

This is not a demo or a proof of concept. The goal is to build a production-quality, local-first AI Document Intelligence Platform using modern technologies and clean architecture.

The application should automate invoice/document processing from email to AI extraction while keeping everything local. Cloud AI services should not be required. Ollama will be used for all LLM processing.

The codebase should be modular, scalable, and maintainable. Every feature should be implemented as if it will eventually be deployed to production.

---

## Development Philosophy

I prefer quality over speed.

Do not generate placeholder code.

Do not generate unnecessary files.

If a feature requires refactoring existing code to improve maintainability, do it.

Follow SOLID principles.

Keep the architecture simple but scalable.

Avoid over-engineering.

Write production-ready code from the beginning.

---

## Current Progress

The full pipeline described in "Overall Application Flow" below is built and working,
end to end: local document ingestion (PDF text extraction, vision-model OCR fallback for
scans/images), AI extraction to structured JSON, invoice storage, chunking + embedding,
hybrid semantic search, and a search UI. Not a single milestone anymore — see
`docs/superpowers/specs/2026-07-28-e5-hybrid-search-design.md` and
`docs/superpowers/plans/2026-07-28-e5-hybrid-search-plan.md` for the current, up-to-date
design and implementation record of the search/embedding layer specifically.

Completed work includes:

- Next.js 15 application, TypeScript, Tailwind CSS
- MongoDB connection, Pino logger, Health API
- Document ingestion (`/api/documents/ingest`): PDF text extraction, image/scan OCR via
  a vision-language model, document-type classification (gates structured extraction to
  invoices only)
- AI extraction to structured JSON (Ollama chat model), with sanitization against known
  model failure modes (address-field body-dumps, hallucinated tax entries)
- Invoice storage (Repository pattern), atomic upsert-by-source-path dedup
- Chunking + embedding (E5 sidecar) + hybrid semantic search (vector similarity +
  lexical-overlap boost + date-range filtering + signal-gap safety net)
- Search UI (`/search`) with filters, full-invoice drawer, chunk-type explanations

MongoDB connectivity has already been verified.

Do not recreate or modify the existing foundation unless necessary.

---

## Technologies

Frontend

- Next.js 15
- React 19
- TypeScript
- Tailwind CSS

Backend

- Next.js Route Handlers

Database

- MongoDB
- Mongoose

Logging

- Pino

AI

- Ollama (chat/extraction/classification/translation, vision)
- Standalone Python/FastAPI sidecar for text embeddings (not Ollama-served)

Models in use

- `qwen2.5:1.5b` — extraction, classification, chat/RAG, translation fallback
- `qwen2.5vl:7b` — vision-based text extraction for scans/images
- `intfloat/multilingual-e5-base` — text embeddings, served by `e5-service/`
  (replaced an earlier `nomic-embed-text` plan, and a subsequent SigLIP2 experiment that
  benchmarked poorly for text-to-text retrieval — see
  `docs/superpowers/specs/2026-07-28-e5-hybrid-search-design.md`)

OCR

- No PaddleOCR. Scans/images route to the vision-language model above instead — decided
  during implementation, not part of the original plan.

Platform

- Windows 11

---

## Coding Standards

Use

- TypeScript everywhere
- ES Modules
- Async/await
- Repository Pattern
- Clean Architecture
- Dependency separation
- Strong typing

Avoid

- JavaScript files
- "any" type
- Large God classes
- Business logic inside API routes
- Duplicate code

Every module should have a single responsibility.

---

## Overall Application Flow

The future application flow will be:

Email Inbox

↓

Read unread emails

↓

Download PDF attachments

↓

Store attachment metadata

↓

Extract PDF text

↓

OCR if required

↓

Send text to Ollama

↓

Receive structured JSON

↓

Validate extracted data

↓

Store invoice

↓

Generate embeddings

↓

Semantic search

↓

Dashboard

Every future milestone should support this workflow.

---

## Current Milestone

The milestone-by-milestone framing above is no longer how work is tracked — the pipeline
through embeddings/search is built (see "Current Progress"). Active design/scope
decisions now live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; check the
most recent dated file there for current state before starting new work. IMAP-based
email ingestion (vs. the current local-file ingestion path) remains unbuilt.

---

## Database Design Philosophy

The database should not only store invoices.

Instead, it should represent the complete processing pipeline.

Think of the lifecycle:

Email

↓

Document

↓

Extraction

↓

Invoice

↓

Embedding

Each stage should have its own model rather than storing everything in one collection.

The database should allow:

- Processing status tracking
- Retry failed processing
- Support multiple document types in the future
- Multiple AI extraction attempts
- Search history
- Auditing

---

## Repository Pattern

Business logic should never directly call Mongoose throughout the application.

Repositories should isolate all database access.

This makes future database changes much easier.

---

## Expected Quality

Assume another senior developer will maintain this project in the future.

Code should be:

- readable
- well structured
- documented where needed
- easy to test
- easy to extend

---

## Working Style

When implementing a milestone:

1. Analyze the current project first.
2. Reuse existing code where possible.
3. Improve code if necessary.
4. Create only the required files.
5. Keep naming consistent.
6. Explain important design decisions.
7. Ensure everything compiles.

Do not generate placeholder TODO files.

---

## Communication Style

When suggesting improvements:

- Explain why.
- Keep explanations concise.
- Avoid unnecessary architectural discussions.
- Focus on the current milestone only.

If there are multiple implementation options, recommend the one that is most maintainable for a production system.
