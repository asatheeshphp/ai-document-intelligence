# SigLIP2 Text Embedding Migration

## Context

This is a follow-on to the vision-quality-classification work already merged to `main` (see `docs/superpowers/specs/2026-07-25-vision-quality-classification-design.md`), which added a configurable vision-language model (Qwen2.5-VL, via Ollama) for scanned/image-based document text extraction, and a document classifier gating structured extraction to invoices.

That prior work explicitly deferred a SigLIP2-based capability as "independent, optional." Through discussion, the actual goal turned out to be different from the original sketch:

- **Not** visual similarity search (SigLIP2 comparing document page images by appearance) — that remains genuinely deferred, out of scope for this plan.
- **Is** using SigLIP2 as the platform's text embedding model, specifically to get multilingual semantic search on the frontend (`/search`, and the RAG-backed `/chat`), replacing the current `nomic-embed-text` (via Ollama).

This is a deliberate choice made with the tradeoffs understood: SigLIP2's text tower is trained for short, caption-style image-text contrastive matching, not long-form text-to-text retrieval, and has a short input token limit (unlike `nomic-embed-text`, which handles much longer chunks). The user chose to proceed anyway, accepting this as an experiment to validate against real invoice data rather than a guaranteed win. The design below is shaped to make that experiment safe to run and easy to evaluate — not to paper over the mismatch.

## Approach

### 1. `siglip-service/` — new standalone Python/FastAPI sidecar

SigLIP2 has no Ollama packaging (it's a HuggingFace `transformers` model, not a GGUF chat/completion model), so it needs its own small serving process, run separately alongside Ollama and MongoDB (not managed by the Node app).

- Loads `google/siglip2-base-patch16-224` (768-dim output) once at startup via `transformers`.
- `POST /embed-text` — request body validated via a Pydantic model:
  ```python
  class TextInput(BaseModel):
      text: str
  ```
  Response: `{ "embedding": list[float], "dimension": int }`. Including `dimension` in every response lets the Node-side migration script (and `SiglipService`) verify consistency without hardcoding an assumed number anywhere.
- `GET /health` — returns `{ "status": "ok", "model": "...", "dimension": 768 }`, so both the migration script and manual verification can confirm which checkpoint is actually loaded and its real output size before writing any vectors.
- Binds to `127.0.0.1` (matches how Ollama already runs on this single-machine POC). Documented as a follow-up to change to `0.0.0.0` if this is ever split across containers — not needed now.
- Only a text-embedding endpoint is built. No `/embed-image` — that would be speculative work toward the still-deferred visual-similarity-search idea (YAGNI).

### 2. `services/siglip.service.ts` — Node HTTP client

```ts
export class SiglipService {
  async embedText(text: string): Promise<number[]>
}
```

- POSTs `{ text }` to `${env.SIGLIP_SERVICE_URL}/embed-text`, returns the `embedding` array.
- Same method shape/signature as `OllamaService.embedText` — a drop-in replacement at both call sites.
- `config/env.ts`: add `SIGLIP_SERVICE_URL` (default `http://127.0.0.1:8000`).

### 3. Swap embedding call sites

Both current callers of `OllamaService.embedText` switch to `SiglipService.embedText`:
- `services/invoice-indexing.service.ts` — embeds each chunk at ingest time.
- `services/search.service.ts` — embeds the user's query at search time.

`OllamaService.embedText` itself is left in place (not deleted) — it's still a reasonable fallback/reference implementation and removing it isn't required by this migration.

### 4. `schemas/invoice-chunker.ts` — restructure unbounded-array sections into per-item chunks

SigLIP2's short token limit means today's chunking (one combined block per section) will regularly truncate or overflow for any invoice with more than a few line items. Restructure:

- `formatLineItems` → one chunk per line item (type stays `line_items`, but `buildInvoiceChunks` emits N drafts instead of 1).
- `formatTaxes` → one chunk per tax entry.
- The references portion of `formatNotes` → one chunk per reference (notes text itself and shipping info stay as their own chunk, since those are single fields, not arrays).
- `header`, `supplier`, `customer`, `payment` (totals + bank details) stay as single chunks — bounded, fixed-field sections that are naturally short regardless of invoice size.

### 5. `scripts/reindex-all-invoices.ts` — one-off migration script

- Iterates every existing `Invoice`, re-runs `InvoiceIndexingService.replaceChunksAndEmbeddings` against its stored `extractedData`, now producing SigLIP2-embedded chunks via the restructured chunker.
- For each embedding written, verifies its length matches the sidecar's reported `dimension` (from `/health`) before persisting — fails loudly (logs and stops) rather than silently writing mismatched vectors if the sidecar's loaded checkpoint ever changes between a first health-check and the actual run.
- Run manually once, after the sidecar is up and the code changes are deployed: `npx tsx scripts/reindex-all-invoices.ts`.

### 6. Threshold recalibration in `search.service.ts`

`DEFAULT_THRESHOLD` (0.45), `MIN_SIGNAL_GAP` (0.08), and `HIGH_CONFIDENCE_MARGIN` (0.15) were empirically measured against `nomic-embed-text`'s score distribution (see the existing code comments explaining exactly how). These numbers do not carry over to SigLIP2's embedding space. The signal-gap heuristic *structure* stays — only the numbers change, and only after real measurement:

- During verification, run a genuinely relevant query and a nonsense query against real re-indexed invoice data (same method the original calibration used), observe the actual score distributions, and update the three constants with the same style of explanatory comment the existing code already has.
- This is treated as a required step, not a "ship and see" — per the user's explicit choice — because shipping stale thresholds tuned for a different embedding space risks the search/chat feature silently returning nothing (or garbage) with no obvious error.

## Files touched

- `siglip-service/` (new: `main.py`, a `requirements.txt`, likely a `README.md` for how to run it)
- `services/siglip.service.ts` (new)
- `config/env.ts` (add `SIGLIP_SERVICE_URL`)
- `services/invoice-indexing.service.ts` (swap embedding call)
- `services/search.service.ts` (swap embedding call; threshold constants updated during verification)
- `schemas/invoice-chunker.ts` (restructure line_items/taxes/references into per-item chunks)
- `scripts/reindex-all-invoices.ts` (new, one-off migration)

## Out of scope for this phase (explicit)

- Visual similarity search / image embeddings via SigLIP2 — genuinely deferred; nothing in this plan builds toward it, and adding it later is a separate, additive plan against the same sidecar.
- Deleting `OllamaService.embedText` — left in place.
- Containerizing the sidecar or changing its network binding from `127.0.0.1` — noted as a future consideration only.
- Any other item already deferred by the prior plan (Schema Registry, duplicate detection, additional document-type extractors, UI for `documentType`/`classificationConfidence`).

## Verification

1. `npx tsc --noEmit` — clean compile.
2. Unit tests for `SiglipService` (mocked HTTP) and the restructured chunker (verify per-item chunk counts/shapes) following the same TDD/Vitest pattern established in the prior plan.
3. Start the SigLIP2 sidecar (`python siglip-service/main.py`), confirm `/health` reports the expected model and dimension.
4. Run `scripts/reindex-all-invoices.ts` against real sample invoices already in the database; confirm every rewritten embedding's length matches the sidecar's reported dimension.
5. Manually exercise `/search` with a genuinely relevant query and a nonsense query; observe real score distributions; update `DEFAULT_THRESHOLD`/`MIN_SIGNAL_GAP`/`HIGH_CONFIDENCE_MARGIN` accordingly, with comments documenting the new measurements (mirroring the existing comment style).
6. Re-run the same manual checks against `/chat` (RAG), confirming grounded answers still surface with the new embedding pipeline.
7. If a non-English sample document/query is available, confirm the multilingual property actually works end-to-end — this is the entire point of the migration, so it should be explicitly checked, not assumed from SigLIP2's documentation alone.
