# Vision-Based Extraction, Document Quality Gating, and Document Classification

## Context

This is a continuing POC per `Enterprise_AI_Document_Intelligence_Platform_Implementation_Plan.docx`. Phases 1-4 (extraction, AI understanding, semantic search) and the Phase 5/7 RAG chat assistant are built and working (`services/document-ingestion.service.ts`, `services/ollama.service.ts`, `services/search.service.ts`, `services/rag.service.ts`, `app/chat/`).

Two gaps in the current pipeline motivated this design:

1. **OCR reliability**: when a PDF's text layer is empty (`extractedText.length < 200`, a fixed magic-number heuristic), `services/ocr.service.ts` shells out to the external `ocrmypdf` CLI (native install or WSL). This is fragile — it depends on an external tool being installed and discoverable on PATH, with no local model-based alternative.
2. **Single document type, no growth path**: the pipeline assumes every document is an invoice. There's no classification step and no architectural seam for other document types, even though the long-term goal (per the implementation plan) is a generic enterprise document intelligence platform, not an invoice-only tool.

The user is currently running Ollama locally with `qwen2.5:1.5b` (chat/extraction) and `nomic-embed-text` (text embeddings), and wants to:
- Replace the `<200-char` / `ocrmypdf` fallback with a local vision-language model, served via Ollama, with the model configurable rather than hardcoded.
- Replace the fixed character-count threshold with a proper document quality assessment.
- Rename the OCR service to reflect its broader responsibility (vision-based text recovery, not literally OCR).
- Add a document classification step, laying the foundation for a multi-document-type platform, while keeping this implementation phase scoped to invoices only.
- Add SigLIP2-based image embeddings for visual similarity search, as an independent, optional capability (SigLIP2 has no Ollama packaging, so it needs a separate small serving component).

Goal: implement these as a cohesive foundation — extensible for future document types and extraction schemas — without over-building beyond what's needed for this POC phase.

## Approach

Four new/renamed components slot into the existing ingestion flow in `document-ingestion.service.ts`, each with a single clear responsibility, none of them touching the already-working text-native extraction path for documents whose text layer is already good.

### Updated pipeline flow

```
PDF ingested
  ├─ pdfjs-dist text layer extraction (unchanged)
  │
  ├─ DocumentQualityService.assess(text, pageCount) → confidence score (NEW)
  │     replaces the fixed <200-char check
  │
  ├─ if confidence < DOCUMENT_QUALITY_THRESHOLD:
  │     1. Render PDF pages → PNG images (NEW: utils/pdf-image-renderer.ts)
  │     2. VisionExtractionService (renamed from OcrService) calls the
  │        configurable vision model via Ollama → raw text
  │     3. Re-run DocumentQualityService on the recovered text as a sanity check
  │
  ├─ DocumentClassifierService.classify(text) → { documentType, confidence } (NEW)
  │     stored on the Document record regardless of type
  │
  └─ if documentType === "INVOICE":
        qwen2.5:1.5b structured extraction (unchanged, existing Zod schema)
     else:
        classified and stored; no structured extraction this phase

Separately, independent of the above (visual similarity search):
  Rendered page images → SigLIP2 sidecar (Python/FastAPI) → image vectors
     → stored → cosine-similarity "similar documents" search
```

### 1. `services/document-quality.service.ts` (new)

```ts
export interface DocumentQualityResult {
  score: number; // 0-1
  signals: {
    charsPerPage: number;
    alphanumericRatio: number;
    recognizableWordRatio: number;
    whitespaceIrregularity: number;
  };
}

export class DocumentQualityService {
  assess(text: string, pageCount: number): DocumentQualityResult
}
```

- Pure heuristic, no model call — fast and deterministic:
  - **charsPerPage**: `text.length / max(pageCount, 1)`, normalized against a reasonable expected density.
  - **alphanumericRatio**: fraction of non-whitespace characters that are letters/digits (low ratio flags garbled extraction — stray symbols, encoding artifacts).
  - **recognizableWordRatio**: fraction of whitespace-delimited tokens matching a simple word-shape regex (e.g. `/^[A-Za-z]{2,}$/` or similar — no dictionary dependency needed for a first pass).
  - **whitespaceIrregularity**: detects excessive runs of whitespace/control characters typical of failed text-layer extraction.
- Combines signals into a single `score` (simple weighted average is sufficient for this phase — no need for a trained model).
- `config/env.ts`: add `DOCUMENT_QUALITY_THRESHOLD` (default calibrated so typical native-text PDFs score above it and empty/garbled extractions score below it — start near where the old 200-char rule effectively drew the line, then tune against real documents).

### 2. `utils/pdf-image-renderer.ts` (new)

- Renders each page of a PDF buffer to a PNG image buffer using `pdfjs-dist`'s canvas rendering API plus `node-canvas` (new dependency).
- `renderPdfPagesToImages(pdfBuffer: Buffer): Promise<Buffer[]>` — one buffer per page, in order.
- This is a new capability; nothing today renders PDF pages to images.

### 3. `services/vision-extraction.service.ts` (renamed from `services/ocr.service.ts`)

- Replaces the `ocrmypdf` / native / WSL shell-out entirely — no more external CLI dependency for this path.
- `class VisionExtractionService { async extractText(pdfBuffer: Buffer): Promise<string> }`:
  1. Calls `renderPdfPagesToImages`.
  2. Base64-encodes each page image.
  3. Calls `OllamaService.visionExtractText(images, model)`.
  4. Concatenates per-page text with a page-break separator.
- Callers (`document-ingestion.service.ts`) update their import/usage from `OcrService`/`ocrPdf` to `VisionExtractionService`/`extractText`.

### 4. `services/ollama.service.ts` — add `visionExtractText`

```ts
async visionExtractText(images: string[], model: string = env.OLLAMA_VISION_MODEL): Promise<string>
```

- POSTs to `${baseUrl}/api/chat` with `images` in the message payload (Ollama's multimodal message format), no `format` schema (free-text transcription).
- Longer timeout than `chatCompletion` — vision models with multi-page image input are slower than the 1.5B text model on CPU (document the reasoning inline, matching the existing timeout-comment style in the file).
- `config/env.ts`: add `OLLAMA_VISION_MODEL` (default `qwen2.5vl:7b`). Nothing in the code hardcodes a model name — always read from `env.OLLAMA_VISION_MODEL`, consistent with how `OLLAMA_CHAT_MODEL`/`OLLAMA_EMBED_MODEL` are already used as defaults with override parameters.

### 5. `services/document-classifier.service.ts` (new)

```ts
export const DocumentTypeLabels = ["INVOICE", "RECEIPT", "PURCHASE_ORDER", "CONTRACT", "RESUME", "OTHER"] as const;

export interface ClassificationResult {
  documentType: typeof DocumentTypeLabels[number];
  confidence: number;
}

export class DocumentClassifierService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}
  async classify(text: string): Promise<ClassificationResult>
}
```

- One `qwen2.5:1.5b` call, schema-constrained via a small Zod enum + confidence schema (same JSON-format-constrained pattern already used by `extractInvoiceData`) — reuses the existing schema-constrained-decoding approach rather than inventing a new one.
- Short prompt: given the document text, pick the single best-matching label and a 0-1 confidence.
- **Extensibility seam**: `DocumentTypeLabels` is the single place new document types get added later. Adding a type here does not require touching the vision/quality/rendering pipeline at all — those stages are already type-agnostic (they only care about "is this text good enough," not what kind of document it is).

### 6. `models/document.model.ts` — extend `DocumentType`

- Extend the enum: `"INVOICE" | "RECEIPT" | "PURCHASE_ORDER" | "CONTRACT" | "RESUME" | "OTHER" | "UNKNOWN"` (matches `DocumentTypeLabels` above, plus the existing default `"UNKNOWN"` for pre-classification state).
- Add `classificationConfidence?: number`.

### 7. `document-ingestion.service.ts` — wire it together

- Replace the `text.trim().length < 200` check with `documentQualityService.assess(text, numPages).score < env.DOCUMENT_QUALITY_THRESHOLD`.
- On low quality: call `visionExtractionService.extractText(fileBuffer)` instead of the old `OcrService.ocrPdf(absolutePath)`; re-assess quality on the result (log both scores for observability, same style as the existing `pdf-extraction`/`pdf-parse-debug` console logging).
- After text is finalized (native or vision-recovered) and before invoice-schema extraction: call `documentClassifierService.classify(text)`, store `documentType`/`classificationConfidence` on the `Document` record unconditionally.
- **Gate structured extraction on classification**: only call `ollamaService.extractInvoiceData(text)` when `documentType === "INVOICE"`. For any other classified type, skip structured extraction, update document status to `EXTRACTED` (text and classification are still saved — just no `Invoice` record), and return a result indicating extraction was skipped pending future support for that type. This is the one behavioral change users will see: non-invoice documents no longer get force-fit into the invoice schema.
- `reextractDocument` (used by `/api/ai/extract` and reindex) keeps working for invoices; if the document isn't classified as `INVOICE`, it should return the same "not supported yet" outcome rather than attempting invoice extraction.

### 8. SigLIP2 sidecar for visual similarity search (independent, optional)

Kept fully decoupled from the extraction/classification pipeline above — if this component isn't running, nothing else in the pipeline is affected.

- **`siglip-service/`** (new top-level directory, not part of the Next.js app): minimal FastAPI app with one endpoint `POST /embed-image` (base64 image in, float vector out), loading a SigLIP2 model via `transformers` once at startup. Run separately (`python siglip-service/main.py`), alongside Ollama — not managed by the Node process.
- **`services/siglip.service.ts`** (new): thin HTTP client, `embedImage(buffer: Buffer): Promise<number[]>`, mirroring `OllamaService.embedText`'s shape.
- `config/env.ts`: add `SIGLIP_SERVICE_URL` (default `http://127.0.0.1:8000`).
- Storage: extend the existing chunk/embedding model (wherever `nomic-embed-text` vectors live today, in `invoice-indexing.service.ts`) with a parallel `imageEmbedding` field per rendered page — exact schema shape to be confirmed against the current Mongo model when implementing.
- New method, e.g. `search.service.ts`'s `findSimilarByImage(documentId)` — cosine similarity over stored image vectors, same pattern as existing text search.
- **Failure mode**: if the sidecar is unreachable, image-embedding indexing logs and skips — the document is still fully extracted/classified via the rest of the pipeline. Visual similarity search is strictly additive.

## Files touched

- `services/document-quality.service.ts` (new)
- `utils/pdf-image-renderer.ts` (new)
- `services/vision-extraction.service.ts` (new, replaces `services/ocr.service.ts` which is deleted)
- `services/ollama.service.ts` (add `visionExtractText`)
- `services/document-classifier.service.ts` (new)
- `models/document.model.ts` (extend `DocumentType` enum, add `classificationConfidence`)
- `services/document-ingestion.service.ts` (wire quality gate, vision fallback, classification gate)
- `config/env.ts` (add `OLLAMA_VISION_MODEL`, `DOCUMENT_QUALITY_THRESHOLD`, `SIGLIP_SERVICE_URL`)
- `siglip-service/` (new, standalone Python service)
- `services/siglip.service.ts` (new)
- `invoice-indexing.service.ts` / relevant Mongo model (add `imageEmbedding` storage)
- `search.service.ts` (add `findSimilarByImage`)
- `package.json` (add `node-canvas` or equivalent PDF-to-image rendering dependency)

## Out of scope for this phase (explicit)

- **Schema Registry** / per-type extraction schemas beyond invoice — classification stores the label, but only `INVOICE` triggers structured extraction. Other types are classified and held for future extractor implementations.
- **Duplicate document detection.**
- **Additional document extractors** (PO, contract, receipt, resume schemas) — future phases build on the `DocumentTypeLabels` seam established here.
- Managing the SigLIP2 sidecar as a supervised/auto-started process — it's started manually, same as Ollama.
- UI beyond minimal "similar documents" surfacing on the existing document detail view — no new pages required.
- Chat/RAG (already implemented in a prior phase — see `2026-07-XX` RAG design, unaffected by this work).
- Replacing `qwen2.5:1.5b` for structured extraction — unaffected by this design.
- Validation engine (Phase 3 business rules) and analytics dashboard enhancements (Phase 6) — carried over as still-deferred from the prior RAG design.

## Verification

1. `npx tsc --noEmit` — confirm everything compiles, no `any`, matches existing strong-typing convention.
2. Feed a batch of existing sample invoices (text-native) through ingestion — confirm `DocumentQualityService` scores them above threshold and behavior is unchanged from today (no regression on the working path).
3. Feed a known scanned/image-only PDF — confirm `DocumentQualityService` correctly triggers the vision fallback, `VisionExtractionService` produces usable text via the configured vision model, and downstream invoice extraction succeeds where it previously required `ocrmypdf`.
4. Feed a non-invoice document (e.g. a resume or contract) — confirm `DocumentClassifierService` labels it correctly, the document is stored with that type and no `Invoice` record is force-created, and the ingestion result clearly communicates "classified, extraction not yet supported for this type."
5. Swap `OLLAMA_VISION_MODEL` to a different pulled vision model and confirm the pipeline picks it up with no code changes.
6. Start the SigLIP2 sidecar, confirm `/embed-image` returns a vector for a rendered page, confirm a similarity query returns sensible neighbors; stop the sidecar and confirm the rest of ingestion is unaffected (no image embeddings stored, no errors surfaced to the user beyond a log line).
7. Confirm `/search`, `/chat`, and existing API routes are unaffected.
