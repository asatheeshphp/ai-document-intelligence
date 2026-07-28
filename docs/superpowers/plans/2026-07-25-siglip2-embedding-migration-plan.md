# SigLIP2 Text Embedding Migration Implementation Plan

> **SUPERSEDED (2026-07-28):** SigLIP2 was retired after live benchmarking showed it too
> weak for text-to-text retrieval; `multilingual-e5-base` replaced it. See
> `docs/superpowers/plans/2026-07-28-e5-hybrid-search-plan.md` for what's current. Kept
> here as a historical record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `nomic-embed-text` (via Ollama) with SigLIP2 (served by a new standalone Python/FastAPI sidecar) as the platform's text embedding model, to enable multilingual semantic search — restructuring invoice chunking to fit SigLIP2's short token limit, migrating existing invoice embeddings, and recalibrating search relevance thresholds against the new embedding space.

**Architecture:** A new `siglip-service/` Python sidecar (analogous to how Ollama already runs alongside the Node app) exposes one endpoint, `POST /embed-text`. A new `SiglipService` Node client mirrors `OllamaService.embedText`'s shape and becomes the sole embedding call site in `invoice-indexing.service.ts` and `search.service.ts`. `schemas/invoice-chunker.ts` is restructured so unbounded-array sections (line items, taxes, references) produce one chunk per item instead of one combined block. A one-off script re-embeds every existing invoice. Search's similarity thresholds get re-measured against real SigLIP2 scores.

**Tech Stack:** Python 3 + FastAPI + Pydantic + `transformers` (new, standalone sidecar), TypeScript/Node (existing app), Vitest (existing test runner), MongoDB (existing, no schema changes needed — `embeddingVector` is an unconstrained `[Number]` array).

**Reference spec:** `docs/superpowers/specs/2026-07-25-siglip2-embedding-migration-design.md`

---

## Prerequisites

- Python 3 and `pip` available on this machine (confirmed already available).
- The vision-quality-classification branch is already merged to `main` — this plan builds on top of that (current `main` has `DocumentQualityService`, `VisionExtractionService`, `DocumentClassifierService`, etc. already in place; none of those are touched by this plan).
- Ollama running locally is NOT required for this plan's automated tests (all mocked), but IS required for Task 8's live verification alongside the new SigLIP2 sidecar (the app still uses Ollama for `extractInvoiceData`, `classifyDocument`, `visionExtractText`, `chatCompletion` — only embedding moves off Ollama).

---

### Task 1: SigLIP2 Python/FastAPI sidecar

**Files:**
- Create: `siglip-service/main.py`
- Create: `siglip-service/requirements.txt`
- Create: `siglip-service/README.md`

This task has no automated test — it's a standalone Python service outside this repo's Vitest/TypeScript tooling, verified manually via `curl` (same precedent as the prior plan's Task 10, which also had no automated test for its thick orchestration piece). Correctness is verified in Step 4 below and again in Task 8's end-to-end check.

- [ ] **Step 1: Create `siglip-service/requirements.txt`**

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
transformers==4.48.0
torch==2.5.1
sentencepiece==0.2.0
```

- [ ] **Step 2: Create `siglip-service/main.py`**

```python
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModel, AutoProcessor
import torch

MODEL_NAME = "google/siglip2-base-patch16-224"

app = FastAPI()

print(f"Loading {MODEL_NAME}...")
model = AutoModel.from_pretrained(MODEL_NAME)
processor = AutoProcessor.from_pretrained(MODEL_NAME)
model.eval()

with torch.no_grad():
    _probe_inputs = processor(text=["probe"], padding="max_length", return_tensors="pt")
    EMBEDDING_DIMENSION = model.get_text_features(**_probe_inputs).shape[-1]

print(f"Loaded {MODEL_NAME}, embedding dimension = {EMBEDDING_DIMENSION}")


class TextInput(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]
    dimension: int


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dimension": EMBEDDING_DIMENSION}


@app.post("/embed-text", response_model=EmbedResponse)
def embed_text(input: TextInput):
    with torch.no_grad():
        inputs = processor(text=[input.text], padding="max_length", truncation=True, return_tensors="pt")
        features = model.get_text_features(**inputs)
        vector = features[0].tolist()

    return EmbedResponse(embedding=vector, dimension=len(vector))
```

**Note for whoever implements this:** the exact `transformers` API for SigLIP2 (e.g. whether `AutoModel`/`AutoProcessor` are the right classes, or whether `get_text_features` is the correct method name for this checkpoint) has not been verified against the actually-installed `transformers==4.48.0` in this environment. If the code above doesn't load or doesn't produce a 1-D embedding vector per call, check the installed version's actual API (`python -c "from transformers import SiglipModel; help(SiglipModel)"` or the HuggingFace model card for `google/siglip2-base-patch16-224`) and adjust — the goal (given text in, get a fixed-size float vector out, matching what `model.config.text_config.hidden_size` or equivalent reports) doesn't change, just the exact method calls might need fixing. This mirrors the same kind of adjustment the prior plan's PDF-rendering task needed for `@napi-rs/canvas`.

- [ ] **Step 3: Install dependencies and start the service**

```bash
cd siglip-service
pip install -r requirements.txt
python main.py
```

Wait, `main.py` as written doesn't actually start a uvicorn server — fix by running it via uvicorn directly instead:

```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

Expected: console shows `Loading google/siglip2-base-patch16-224...` (first run downloads the checkpoint from HuggingFace — may take a few minutes depending on connection), then `Loaded google/siglip2-base-patch16-224, embedding dimension = 768`, then uvicorn's normal "Uvicorn running on http://127.0.0.1:8000" message.

- [ ] **Step 4: Verify with curl**

```bash
curl http://127.0.0.1:8000/health
```
Expected: `{"status":"ok","model":"google/siglip2-base-patch16-224","dimension":768}`

```bash
curl -X POST http://127.0.0.1:8000/embed-text -H "Content-Type: application/json" -d "{\"text\": \"hello world\"}"
```
Expected: JSON with an `embedding` array of length matching the `dimension` reported by `/health`, and a `dimension` field with the same number.

- [ ] **Step 5: Create `siglip-service/README.md`**

```markdown
# SigLIP2 Embedding Sidecar

Standalone FastAPI service serving SigLIP2 text embeddings. Run alongside Ollama and MongoDB — not managed by the Node app.

## Setup

\`\`\`bash
cd siglip-service
pip install -r requirements.txt
\`\`\`

## Run

\`\`\`bash
uvicorn main:app --host 127.0.0.1 --port 8000
\`\`\`

First run downloads the `google/siglip2-base-patch16-224` checkpoint from HuggingFace (cached locally afterward).

## Endpoints

- `GET /health` — `{ status, model, dimension }`
- `POST /embed-text` — body `{ "text": string }`, returns `{ embedding: number[], dimension: number }`
```

- [ ] **Step 6: Commit**

```bash
git add siglip-service/
git commit -m "feat: add SigLIP2 text embedding sidecar (Python/FastAPI)"
```

---

### Task 2: `services/siglip.service.ts` — Node client

**Files:**
- Modify: `config/env.ts`
- Create: `services/siglip.service.ts`
- Test: `services/siglip.service.test.ts`

- [ ] **Step 1: Add `SIGLIP_SERVICE_URL` to `config/env.ts`**

Modify `config/env.ts`:

```ts
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.string().default("3000"),
  MONGODB_URI: z.string(),
  OLLAMA_BASE_URL: z.string(),
  OLLAMA_CHAT_MODEL: z.string(),
  OLLAMA_EMBED_MODEL: z.string(),
  OLLAMA_VISION_MODEL: z.string().default("qwen2.5vl:7b"),
  DOCUMENT_QUALITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  SIGLIP_SERVICE_URL: z.string().default("http://127.0.0.1:8000"),
});

export const env = schema.parse(process.env);
```

Append to `.env.local`:

```
SIGLIP_SERVICE_URL=http://127.0.0.1:8000
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { SiglipService } from "@/services/siglip.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("SiglipService.embedText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts text to /embed-text and returns the embedding vector", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { embedding: [0.1, 0.2, 0.3], dimension: 3 },
    });

    const service = new SiglipService();
    const result = await service.embedText("hello world");

    expect(result).toEqual([0.1, 0.2, 0.3]);

    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, { text: string }];
    expect(url).toBe(`${env.SIGLIP_SERVICE_URL.replace(/\/$/, "")}/embed-text`);
    expect(body.text).toBe("hello world");
  });

  it("returns an empty array if the response has no embedding field", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: {} });

    const service = new SiglipService();
    const result = await service.embedText("anything");

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- siglip.service`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `SiglipService`**

```ts
import axios from "axios";
import { env } from "@/config/env";

export class SiglipService {
  async embedText(text: string): Promise<number[]> {
    const baseUrl = env.SIGLIP_SERVICE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/embed-text`,
      { text },
      {
        // SigLIP2 text-embedding calls are a single forward pass over a short input —
        // much faster than Ollama's chat-completion calls, but still allow real headroom
        // for CPU-only inference and first-request model warmup.
        timeout: 30000,
      }
    );

    return response.data?.embedding ?? [];
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- siglip.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/env.ts .env.local services/siglip.service.ts services/siglip.service.test.ts
git commit -m "feat: add SiglipService Node client and SIGLIP_SERVICE_URL config"
```

---

### Task 3: Restructure `schemas/invoice-chunker.ts` into per-item chunks

**Files:**
- Modify: `schemas/invoice-chunker.ts`
- Test: `schemas/invoice-chunker.test.ts` (new — this file has no existing tests)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildInvoiceChunks } from "@/schemas/invoice-chunker";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

const emptyAddress = { raw: null, street: null, city: null, state: null, postalCode: null, country: null };
const emptyParty = { name: null, address: emptyAddress, taxId: null, email: null, phone: null };

function baseExtraction(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
    supplier: emptyParty,
    customer: emptyParty,
    shipping: { address: emptyAddress, method: null, trackingNumber: null },
    lineItems: [],
    taxes: [],
    totals: { subtotal: null, totalTax: null, discount: null, shippingCharge: null, grandTotal: null, amountInWords: null },
    bankDetails: { bankName: null, accountName: null, accountNumber: null, ifscCode: null, swiftCode: null, branch: null },
    notes: null,
    references: [],
    additionalFields: {},
    ...overrides,
  };
}

describe("buildInvoiceChunks", () => {
  it("emits one chunk per line item instead of one combined block", () => {
    const extraction = baseExtraction({
      lineItems: [
        { description: "Widget A", quantity: 2, unit: "pcs", unitPrice: 10, taxRate: null, amount: 20 },
        { description: "Widget B", quantity: 1, unit: "pcs", unitPrice: 5, taxRate: null, amount: 5 },
        { description: "Widget C", quantity: 3, unit: "pcs", unitPrice: 7, taxRate: null, amount: 21 },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const lineItemChunks = chunks.filter((chunk) => chunk.type === "line_items");

    expect(lineItemChunks).toHaveLength(3);
    expect(lineItemChunks[0].text).toContain("Widget A");
    expect(lineItemChunks[1].text).toContain("Widget B");
    expect(lineItemChunks[2].text).toContain("Widget C");
    // Each chunk should be short — no chunk should contain another item's description.
    expect(lineItemChunks[0].text).not.toContain("Widget B");
  });

  it("emits one chunk per tax entry", () => {
    const extraction = baseExtraction({
      taxes: [
        { type: "CGST", rate: 9, amount: 18 },
        { type: "SGST", rate: 9, amount: 18 },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const taxChunks = chunks.filter((chunk) => chunk.type === "taxes");

    expect(taxChunks).toHaveLength(2);
    expect(taxChunks[0].text).toContain("CGST");
    expect(taxChunks[1].text).toContain("SGST");
    expect(taxChunks[0].text).not.toContain("SGST");
  });

  it("emits one chunk per reference, tagged as notes type", () => {
    const extraction = baseExtraction({
      references: [
        { type: "PO", value: "PO-123" },
        { type: "GRN", value: "GRN-456" },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const noteChunks = chunks.filter((chunk) => chunk.type === "notes");

    expect(noteChunks.some((chunk) => chunk.text.includes("PO-123"))).toBe(true);
    expect(noteChunks.some((chunk) => chunk.text.includes("GRN-456"))).toBe(true);
    // The two references should be in separate chunks, not combined into one.
    const poChunk = noteChunks.find((chunk) => chunk.text.includes("PO-123"));
    expect(poChunk?.text).not.toContain("GRN-456");
  });

  it("keeps header, supplier, customer, and payment as single combined chunks", () => {
    const extraction = baseExtraction({
      invoice: { invoiceNumber: "INV-1", invoiceDate: null, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
      supplier: { ...emptyParty, name: "Acme Corp", email: "billing@acme.com" },
      totals: { subtotal: 100, totalTax: 18, discount: null, shippingCharge: null, grandTotal: 118, amountInWords: null },
    });

    const chunks = buildInvoiceChunks(extraction);

    expect(chunks.filter((chunk) => chunk.type === "header")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "supplier")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "payment")).toHaveLength(1);
  });

  it("falls back to a single JSON chunk when there is no extractable data at all", () => {
    const chunks = buildInvoiceChunks(baseExtraction());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("other");
  });

  it("produces contiguous, non-overlapping offsets across all chunks", () => {
    const extraction = baseExtraction({
      lineItems: [{ description: "Widget A", quantity: 1, unit: null, unitPrice: 10, taxRate: null, amount: 10 }],
      taxes: [{ type: "VAT", rate: 20, amount: 2 }],
    });

    const chunks = buildInvoiceChunks(extraction);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- invoice-chunker`
Expected: FAIL — the "one chunk per line item" and "one chunk per tax entry" and "one chunk per reference" tests fail because the current implementation combines each section into a single block (e.g. `lineItemChunks` will have length 1, not 3).

- [ ] **Step 3: Rewrite `schemas/invoice-chunker.ts`**

Replace the entire file:

```ts
import type { InvoiceExtraction } from "@/schemas/invoice.schema";
import type { ChunkType } from "@/models/chunk.model";

export interface InvoiceChunkDraft {
  type: ChunkType;
  text: string;
  start: number;
  end: number;
  tokenCount: number;
}

type Address = InvoiceExtraction["supplier"]["address"];
type Party = InvoiceExtraction["supplier"];

function formatAddress(address: Address): string | null {
  if (address.raw) return address.raw;
  const parts = [address.street, address.city, address.state, address.postalCode, address.country].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatParty(label: string, party: Party): string | null {
  const lines: string[] = [];
  if (party.name) lines.push(`${label}: ${party.name}`);

  const address = formatAddress(party.address);
  if (address) lines.push(`Address: ${address}`);
  if (party.taxId) lines.push(`Tax ID: ${party.taxId}`);
  if (party.email) lines.push(`Email: ${party.email}`);
  if (party.phone) lines.push(`Phone: ${party.phone}`);

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatHeader(extraction: InvoiceExtraction): string | null {
  const { invoice } = extraction;
  const lines: string[] = [];
  if (invoice.invoiceNumber) lines.push(`Invoice Number: ${invoice.invoiceNumber}`);
  if (invoice.invoiceDate) lines.push(`Invoice Date: ${invoice.invoiceDate}`);
  if (invoice.dueDate) lines.push(`Due Date: ${invoice.dueDate}`);
  if (invoice.poNumber) lines.push(`PO Number: ${invoice.poNumber}`);
  if (invoice.currency) lines.push(`Currency: ${invoice.currency}`);
  if (invoice.paymentTerms) lines.push(`Payment Terms: ${invoice.paymentTerms}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

// Returns one string per line item (not one combined block) so each chunk stays short
// enough for SigLIP2's limited text-embedding input length.
function formatLineItems(items: InvoiceExtraction["lineItems"]): string[] {
  const meaningful = items.filter((item) => item.description || item.amount != null);

  return meaningful.map((item) => {
    const parts: string[] = [item.description ?? "Item"];
    if (item.quantity != null) parts.push(`qty ${item.quantity}${item.unit ? ` ${item.unit}` : ""}`);
    if (item.unitPrice != null) parts.push(`unit price ${item.unitPrice}`);
    if (item.taxRate != null) parts.push(`tax rate ${item.taxRate}%`);
    if (item.amount != null) parts.push(`amount ${item.amount}`);
    return parts.join(", ");
  });
}

// One string per tax entry, same reasoning as formatLineItems.
function formatTaxes(taxes: InvoiceExtraction["taxes"]): string[] {
  const meaningful = taxes.filter((tax) => tax.type || tax.rate != null || tax.amount != null);

  return meaningful.map((tax) => {
    const parts: string[] = [tax.type ?? "Tax"];
    if (tax.rate != null) parts.push(`rate ${tax.rate}%`);
    if (tax.amount != null) parts.push(`amount ${tax.amount}`);
    return parts.join(", ");
  });
}

// One string per reference, same reasoning as formatLineItems.
function formatReferences(references: InvoiceExtraction["references"]): string[] {
  const meaningful = references.filter((ref) => ref.type || ref.value);
  return meaningful.map((ref) => `${ref.type ?? "Reference"}: ${ref.value ?? "N/A"}`);
}

function formatPayment(extraction: InvoiceExtraction): string | null {
  const { totals, bankDetails } = extraction;
  const lines: string[] = [];

  if (totals.subtotal != null) lines.push(`Subtotal: ${totals.subtotal}`);
  if (totals.discount != null) lines.push(`Discount: ${totals.discount}`);
  if (totals.shippingCharge != null) lines.push(`Shipping Charge: ${totals.shippingCharge}`);
  if (totals.totalTax != null) lines.push(`Total Tax: ${totals.totalTax}`);
  if (totals.grandTotal != null) lines.push(`Grand Total: ${totals.grandTotal}`);
  if (totals.amountInWords) lines.push(`Amount In Words: ${totals.amountInWords}`);

  const bankLines: string[] = [];
  if (bankDetails.bankName) bankLines.push(`Bank Name: ${bankDetails.bankName}`);
  if (bankDetails.accountName) bankLines.push(`Account Name: ${bankDetails.accountName}`);
  if (bankDetails.accountNumber) bankLines.push(`Account Number: ${bankDetails.accountNumber}`);
  if (bankDetails.ifscCode) bankLines.push(`IFSC Code: ${bankDetails.ifscCode}`);
  if (bankDetails.swiftCode) bankLines.push(`SWIFT Code: ${bankDetails.swiftCode}`);
  if (bankDetails.branch) bankLines.push(`Branch: ${bankDetails.branch}`);

  if (bankLines.length > 0) {
    lines.push("Bank Details:", ...bankLines);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

// Notes text + shipping info only — these are bounded, fixed-field data, unlike
// references (an open-ended array), which gets its own per-item chunks instead.
function formatNotesAndShipping(extraction: InvoiceExtraction): string | null {
  const { notes, shipping } = extraction;
  const lines: string[] = [];

  if (notes) lines.push(notes);

  const shippingAddress = formatAddress(shipping.address);
  if (shippingAddress || shipping.method || shipping.trackingNumber) {
    lines.push("Shipping:");
    if (shippingAddress) lines.push(`Address: ${shippingAddress}`);
    if (shipping.method) lines.push(`Method: ${shipping.method}`);
    if (shipping.trackingNumber) lines.push(`Tracking Number: ${shipping.trackingNumber}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function buildInvoiceChunks(extraction: InvoiceExtraction): InvoiceChunkDraft[] {
  const chunks: InvoiceChunkDraft[] = [];
  let offset = 0;

  const pushChunk = (type: ChunkType, text: string) => {
    const start = offset;
    const end = start + text.length;
    chunks.push({
      type,
      text,
      start,
      end,
      tokenCount: text.split(/\s+/).filter(Boolean).length,
    });
    offset = end + 1;
  };

  const singleTextSections: Array<{ type: ChunkType; text: string | null }> = [
    { type: "header", text: formatHeader(extraction) },
    { type: "supplier", text: formatParty("Supplier", extraction.supplier) },
    { type: "customer", text: formatParty("Customer", extraction.customer) },
  ];

  for (const section of singleTextSections) {
    if (section.text) pushChunk(section.type, section.text);
  }

  for (const text of formatLineItems(extraction.lineItems)) {
    pushChunk("line_items", text);
  }

  for (const text of formatTaxes(extraction.taxes)) {
    pushChunk("taxes", text);
  }

  const payment = formatPayment(extraction);
  if (payment) pushChunk("payment", payment);

  const notesAndShipping = formatNotesAndShipping(extraction);
  if (notesAndShipping) pushChunk("notes", notesAndShipping);

  for (const text of formatReferences(extraction.references)) {
    pushChunk("notes", text);
  }

  if (chunks.length === 0) {
    const fallbackText = JSON.stringify(extraction);
    pushChunk("other", fallbackText);
  }

  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- invoice-chunker`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all existing tests still pass — `invoice-indexing.service.ts` isn't tested directly today (no existing test file), so this restructuring shouldn't break any other test file, but confirm nothing else references the old `formatLineItems`/`formatTaxes`/`formatNotes` return shapes.

- [ ] **Step 6: Commit**

```bash
git add schemas/invoice-chunker.ts schemas/invoice-chunker.test.ts
git commit -m "feat: restructure invoice chunker into per-item chunks for short-token embedding models"
```

---

### Task 4: Swap embedding call sites to `SiglipService`

**Files:**
- Modify: `services/invoice-indexing.service.ts`
- Modify: `services/search.service.ts`
- Modify: `services/document-ingestion.service.ts`

None of these files have existing test coverage today (both are thin orchestration layers over real repositories, same situation as `document-ingestion.service.ts` in the prior plan). This task is verified via `npx tsc --noEmit` and the live checks in Task 8, not a new unit test.

- [ ] **Step 1: Update `services/invoice-indexing.service.ts`**

Replace the file's imports and constructor:

```ts
import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { SiglipService } from "@/services/siglip.service";
import { buildInvoiceChunks } from "@/schemas/invoice-chunker";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

export class InvoiceIndexingService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly siglipService: SiglipService = new SiglipService()
  ) {}

  /**
   * Rebuilds chunks + embeddings for a document from its current structured extraction.
   * Safe to call for a brand-new document (nothing to delete) or to re-index an
   * already-processed one after re-extraction. New embeddings are generated in full
   * BEFORE any existing chunk/embedding is deleted, so a mid-run failure leaves the
   * previous (stale but complete) index untouched rather than emptying it.
   */
  async replaceChunksAndEmbeddings(
    documentId: Types.ObjectId | string,
    invoiceId: Types.ObjectId | string,
    extraction: InvoiceExtraction,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const drafts = buildInvoiceChunks(extraction);

    const vectors: number[][] = [];
    for (const draft of drafts) {
      vectors.push(await this.siglipService.embedText(draft.text));
    }

    await this.repository.deleteChunksByDocumentId(documentId);
    await this.repository.deleteEmbeddingsByDocumentId(documentId);

    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      const vector = vectors[i];

      const chunkDoc = await this.repository.createChunk({
        invoiceId,
        documentId,
        chunkType: draft.type,
        text: draft.text,
        startOffset: draft.start,
        endOffset: draft.end,
        tokenCount: draft.tokenCount,
        metadata,
      });

      await this.repository.createEmbedding({
        invoiceId,
        documentId,
        chunkId: chunkDoc._id,
        chunkType: draft.type,
        embeddingModel: "siglip2",
        embeddingVector: vector,
        status: "COMPLETED",
        metadata,
      });
    }
  }
}
```

Note: `embeddingModel` changes from `env.OLLAMA_EMBED_MODEL` (a runtime env var, since Ollama models are named/swappable) to the literal string `"siglip2"`, since the sidecar currently only serves one fixed checkpoint (`google/siglip2-base-patch16-224`, hardcoded in `siglip-service/main.py`) rather than an env-configurable model name. This also removes this file's now-unused `import { env } from "@/config/env"` — the whole point of removing the Ollama dependency here.

- [ ] **Step 2: Update `services/search.service.ts`**

Replace the file's imports and constructor:

```ts
import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { SiglipService } from "@/services/siglip.service";
import { cosineSimilarity } from "@/utils/vector";
```

```ts
export class SearchService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly vectorRepository: VectorRepository = new VectorRepository(),
    private readonly siglipService: SiglipService = new SiglipService()
  ) {}

  async search(input: SearchInput): Promise<SearchOutput> {
    const topK = input.topK && input.topK > 0 ? Math.min(Math.floor(input.topK), MAX_TOP_K) : DEFAULT_TOP_K;
    const threshold = input.threshold ?? DEFAULT_THRESHOLD;
    const filters = input.filters;

    const queryVector = await this.siglipService.embedText(input.query);
```

(Only the constructor's third dependency and the single `this.ollamaService.embedText(input.query)` → `this.siglipService.embedText(input.query)` call change — everything else in `search()`, including the threshold logic, `SearchFilters`, `SearchInput`/`SearchOutput`/`SearchResultItem` types, and result-mapping logic, stays exactly as-is for this step. Threshold values themselves are updated in Task 6, not here.)

- [ ] **Step 3: Fix `services/document-ingestion.service.ts`'s now-broken `InvoiceIndexingService` instantiation**

`InvoiceIndexingService`'s constructor second parameter just changed from `OllamaService` to `SiglipService` (Step 1 above). `services/document-ingestion.service.ts` (from the prior vision-quality-classification plan) currently constructs it as:

```ts
    private readonly indexingService: InvoiceIndexingService = new InvoiceIndexingService(
      repository,
      ollamaService
    ),
```

This now passes an `OllamaService` instance where a `SiglipService` is expected and will fail to type-check. Replace it with:

```ts
    private readonly indexingService: InvoiceIndexingService = new InvoiceIndexingService(repository),
```

(Letting `InvoiceIndexingService`'s own default parameter construct its `SiglipService` — `document-ingestion.service.ts` has no other reason to hold a `SiglipService` instance itself, so there's no benefit to threading one through here.) No import changes needed in this file — `ollamaService` is still used elsewhere in the same constructor (for `visionExtractionService` and `documentClassifierService`) and by `extractInvoiceData`/`classifyDocument` calls later in the file.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. This is the step that confirms Step 3's fix actually resolved the constructor mismatch — if `document-ingestion.service.ts` still fails to compile here, re-check that edit. (`services/rag.service.ts` and `app/api/chat/route.ts` construct `SearchService` with its default constructor and don't reference `OllamaService` directly for search, so they should be unaffected — but if `tsc` flags anything there, check that file's `SearchService` usage before assuming it's unrelated.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass — none of the three modified files have direct test coverage, so this should be a no-op regression check confirming nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add services/invoice-indexing.service.ts services/search.service.ts services/document-ingestion.service.ts
git commit -m "feat: switch embedding generation from OllamaService to SiglipService"
```

---

### Task 5: `scripts/reindex-all-invoices.ts` — migration script

**Files:**
- Create: `scripts/reindex-all-invoices.ts`

No automated test — this is a one-off operational script, run manually once against a real database. Verified in Step 3 below and again in Task 8.

- [ ] **Step 1: Write the script**

```ts
import axios from "axios";
import { env } from "@/config/env";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { InvoiceIndexingService } from "@/services/invoice-indexing.service";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

async function getSiglipDimension(): Promise<number> {
  const baseUrl = env.SIGLIP_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${baseUrl}/health`);
  const dimension = response.data?.dimension;

  if (typeof dimension !== "number") {
    throw new Error(`Could not read embedding dimension from ${baseUrl}/health — is the SigLIP2 sidecar running?`);
  }

  return dimension;
}

async function main() {
  const expectedDimension = await getSiglipDimension();
  console.log(`SigLIP2 sidecar reports embedding dimension: ${expectedDimension}`);

  const repository = new ProcessingRepository();
  const indexingService = new InvoiceIndexingService(repository);

  const invoices = await repository.listInvoices();
  console.log(`Found ${invoices.length} invoices to re-index.`);

  let succeeded = 0;
  let failed = 0;

  for (const invoice of invoices) {
    try {
      const extraction = invoice.extractedData as unknown as InvoiceExtraction;

      await indexingService.replaceChunksAndEmbeddings(invoice.documentId, invoice._id, extraction, {
        source: "siglip-migration",
      });

      const rebuiltEmbeddings = await repository.findEmbeddingsByInvoiceId(invoice._id);
      const mismatched = rebuiltEmbeddings.filter((embedding) => embedding.embeddingVector.length !== expectedDimension);

      if (mismatched.length > 0) {
        throw new Error(
          `${mismatched.length} embedding(s) for invoice ${invoice._id.toString()} have the wrong dimension ` +
            `(expected ${expectedDimension}). Aborting — check whether the sidecar's loaded checkpoint changed mid-run.`
        );
      }

      succeeded += 1;
      console.log(`Re-indexed invoice ${invoice._id.toString()} (${invoice.invoiceNumber ?? "no invoice number"})`);
    } catch (err) {
      failed += 1;
      console.error(`Failed to re-index invoice ${invoice._id.toString()}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Done. ${succeeded} succeeded, ${failed} failed out of ${invoices.length} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Migration script failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run it against real data**

Prerequisite: the SigLIP2 sidecar from Task 1 must be running (`uvicorn main:app --host 127.0.0.1 --port 8000` from `siglip-service/`), and MongoDB must be running with at least one existing invoice (e.g. from prior manual testing of the vision-quality-classification plan).

Run: `npx tsx scripts/reindex-all-invoices.ts`

Expected: console output reporting the sidecar's dimension, the number of invoices found, a per-invoice success line for each, and a final "N succeeded, 0 failed" summary. If there are zero invoices in the database yet, ingest at least one first (e.g. via `/api/documents/ingest` with one of the sample PDFs) so this step has something real to verify against.

- [ ] **Step 4: Commit**

```bash
git add scripts/reindex-all-invoices.ts
git commit -m "feat: add one-off migration script to re-embed existing invoices with SigLIP2"
```

---

### Task 6: Recalibrate `search.service.ts` similarity thresholds

**Files:**
- Modify: `services/search.service.ts`

This task cannot be reduced to a code sketch ahead of time — the whole point is to replace numbers that were empirically measured against `nomic-embed-text`'s score distribution with numbers measured against SigLIP2's actual score distribution, which requires the sidecar running and real re-indexed data (from Task 5) to measure against. This mirrors exactly how the *original* thresholds in this file were derived (per the file's own existing comments).

**Prerequisites for this task:** SigLIP2 sidecar running, at least one invoice re-indexed via Task 5's script, dev server running (`npm run dev`).

- [ ] **Step 1: Run a genuinely relevant query and record scores**

Using the `/search` page or `POST /api/search` directly, run a query that should clearly match a real re-indexed invoice (e.g. its vendor name, or a distinctive line-item description). Temporarily set `threshold: 0` in the request (or via the search page's filters, if exposed) so all candidate scores come back regardless of the current threshold, and record:
- The top score
- The mean score across all candidates
- The gap between the top score and the next-highest distinct score

- [ ] **Step 2: Run a nonsense/unrelated query and record scores**

Run a query with no real relationship to any indexed content (e.g. a string of unrelated words). Record the same three numbers as Step 1.

- [ ] **Step 3: Repeat with a second nonsense query**

The original calibration used two different nonsense queries to confirm the noise floor isn't a single lucky/unlucky measurement — do the same here with a different unrelated query.

- [ ] **Step 4: Update the threshold constants**

Modify `services/search.service.ts`'s constants (currently `DEFAULT_THRESHOLD = 0.45`, `MIN_SIGNAL_GAP = 0.08`, `HIGH_CONFIDENCE_MARGIN = 0.15`) with values derived from Steps 1-3's real measurements, following the same reasoning structure as the existing comments (a threshold that sits between the relevant-query's weakest reasonable match and the nonsense-query noise ceiling; a signal-gap minimum derived from the observed gap difference between a real match and nonsense queries; a high-confidence margin that skips the gap check when the top score is already clearly above threshold). Rewrite the explanatory comments above each constant to describe the actual SigLIP2 measurements taken, in the same style as the current comments (which cite specific measured numbers) — do not leave the old nomic-embed-text-specific numbers in the comments.

- [ ] **Step 5: Re-verify**

Re-run the relevant query and both nonsense queries from Steps 1-3 with the updated threshold in place (no override this time — use the new `DEFAULT_THRESHOLD`). Expected: the relevant query returns the expected invoice; both nonsense queries return zero results.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit` — expected: no errors.

```bash
git add services/search.service.ts
git commit -m "fix: recalibrate search similarity thresholds for SigLIP2's embedding space"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: all tests pass, including the new `siglip.service.test.ts` and `invoice-chunker.test.ts` from Tasks 2 and 3.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Confirm the SigLIP2 sidecar and dimension check**

With the sidecar running, `curl http://127.0.0.1:8000/health` and confirm the reported dimension matches what `scripts/reindex-all-invoices.ts` verified in Task 5.

- [ ] **Step 4: Ingest a new document end-to-end**

Ingest a sample invoice that hasn't been indexed yet (or re-ingest one) via `/api/documents/ingest`, with the SigLIP2 sidecar running. Expected: ingestion succeeds, and its embeddings are created via SigLIP2 (check the `Embedding` documents' `embeddingModel` field reads `"siglip2"`, not an Ollama model name).

- [ ] **Step 5: Verify `/search` works with the recalibrated thresholds**

Run a genuinely relevant query against `/search` (or `POST /api/search`) and confirm it returns the expected invoice with a score above the new `DEFAULT_THRESHOLD`. Run a nonsense query and confirm it returns no results.

- [ ] **Step 6: Verify `/chat` (RAG) still works**

Ask a question via `/chat` that should be answerable from an indexed invoice. Expected: a grounded answer with sources, same behavior as before this migration — `rag.service.ts` itself wasn't touched, so this exercises whether `SearchService`'s new embedding pipeline still feeds it correctly.

- [ ] **Step 7: Verify the multilingual property actually works**

This is the entire point of the migration — don't assume it from SigLIP2's documentation. If you have (or can quickly create) a non-English sample invoice or a non-English search query for an already-indexed English invoice (e.g. searching for a vendor name or amount phrased in another language), run it against `/search` and confirm it still surfaces relevant results. If no non-English sample data exists, create a minimal one (e.g. a plain-text document with a distinctive vendor name and a non-English query referencing it) rather than skipping this check — it validates the actual reason this migration was done.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "chore: verify SigLIP2 embedding migration end-to-end"
```
