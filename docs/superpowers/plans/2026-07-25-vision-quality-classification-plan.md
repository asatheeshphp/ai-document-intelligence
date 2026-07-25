# Vision-Based Extraction, Document Quality Gating, and Document Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed `<200-char` / `ocrmypdf` fallback with a heuristic document-quality gate plus a configurable local vision-language model (via Ollama), and add a document classification step that gates structured extraction to invoices while laying the groundwork for future document types — without touching the already-working text-native extraction path.

**Architecture:** Four new services (`DocumentQualityService`, `VisionExtractionService` replacing `OcrService`, `DocumentClassifierService`, and a `pdf-image-renderer` util) slot into `document-ingestion.service.ts`'s existing flow. Quality assessment is a pure heuristic (no model call); vision extraction and classification both go through `OllamaService`, using the same schema-constrained-decoding pattern already used by `extractInvoiceData`. Classification gates whether structured extraction runs at all — non-invoice documents get classified and stored but not force-fit into the invoice schema.

**Tech Stack:** TypeScript, Next.js 16, Mongoose, Ollama (`qwen2.5:1.5b` for text/classification, configurable vision model e.g. `qwen2.5vl:7b`), `pdfjs-dist`, `@napi-rs/canvas` (new), Vitest (new, this codebase currently has zero test infrastructure).

**Reference spec:** `docs/superpowers/specs/2026-07-25-vision-quality-classification-design.md`

**Scope note:** This plan covers the core pipeline change only (quality gate, vision extraction, classification). The SigLIP2 image-embedding / visual-similarity-search capability described in the same spec is intentionally a separate plan, written and executed independently, since the spec itself treats it as an optional, decoupled capability.

---

## Prerequisites

- Git must be installed and on PATH (`git --version` should succeed) before Task 1's commit step. If not yet installed, install Git for Windows first.
- Ollama running locally (`http://127.0.0.1:11434`) with `qwen2.5:1.5b` and `nomic-embed-text` already pulled (existing setup). Pulling a vision model (e.g. `qwen2.5vl:7b`) is only needed for manual end-to-end verification in Task 10, not for the automated tests in Tasks 1-9 (those mock `OllamaService`).

---

### Task 1: Initialize git and set up Vitest

**Files:**
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Modify: `package.json`

- [ ] **Step 1: Initialize the git repository**

Run: `git init`
Expected: `Initialized empty Git repository in F:/ai-document-intelligence/.git/`

- [ ] **Step 2: Make a baseline commit of the existing codebase**

```bash
git add -A
git commit -m "chore: baseline commit before vision/quality/classification work"
```

Expected: a commit succeeds (there is a `.gitignore` already present, so `node_modules`, `.next`, and `.env*` are excluded).

- [ ] **Step 3: Install Vitest and the PDF-to-image rendering dependency**

Run: `npm install --save-dev vitest`
Run: `npm install @napi-rs/canvas`

Expected: both commands complete without error; `package.json` gains `vitest` under `devDependencies` and `@napi-rs/canvas` under `dependencies`.

- [ ] **Step 4: Add the `test` script**

Modify `package.json` — in `"scripts"`, add a `test` entry alongside the existing ones:

```json
{
  "name": "ai-document-intelligence",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run"
  },
```

(Leave `dependencies`/`devDependencies` as installed by npm in Step 3 — don't hand-edit version numbers.)

- [ ] **Step 5: Create `vitest.setup.ts`**

This loads `.env.local` before tests run, since `config/env.ts` reads `process.env` eagerly at import time and nothing in this project currently loads `.env.local` outside of Next.js's own dev server:

```ts
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 7: Verify the test runner works with no tests yet**

Run: `npm test`
Expected: Vitest starts, reports "No test files found" (or similar) and exits — confirms the config/setup files are valid before any real tests are added.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts vitest.setup.ts package.json package-lock.json
git commit -m "chore: add Vitest test runner and pdf image rendering dependency"
```

---

### Task 2: `DocumentQualityService` — heuristic document quality scoring

**Files:**
- Create: `services/document-quality.service.ts`
- Test: `services/document-quality.service.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { DocumentQualityService } from "@/services/document-quality.service";

describe("DocumentQualityService", () => {
  const service = new DocumentQualityService();

  it("scores empty text at the minimum", () => {
    const result = service.assess("", 1);
    expect(result.score).toBeLessThan(0.1);
  });

  it("scores dense symbol-only garbage low", () => {
    const garbled = "%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%";
    const result = service.assess(garbled, 1);
    expect(result.score).toBeLessThan(0.3);
  });

  it("scores clean, readable invoice-like text highly", () => {
    const clean = `Invoice Number INV dash one thousand one Date January fifteen twenty twenty six
Vendor ABC Technologies Private Limited Customer Example Corporation
Description Quantity Unit Price Amount Consulting Services ten hours
Total amount due fifteen hundred dollars Payment terms net thirty days
Thank you for your business We appreciate your prompt payment
Please remit payment to the address listed above
Contact accounts receivable for any questions regarding this invoice`;
    const result = service.assess(clean, 1);
    expect(result.score).toBeGreaterThan(0.6);
  });

  it("scores the same text lower per-page as page count increases", () => {
    const text = "Some readable words here and there in this document body";
    const onePage = service.assess(text, 1);
    const fivePages = service.assess(text, 5);
    expect(fivePages.signals.charsPerPage).toBeLessThan(onePage.signals.charsPerPage);
  });

  it("never divides by zero on empty tokens", () => {
    const result = service.assess("   ", 1);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- document-quality`
Expected: FAIL — `Cannot find module '@/services/document-quality.service'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
export interface DocumentQualitySignals {
  charsPerPage: number;
  alphanumericRatio: number;
  recognizableWordRatio: number;
  whitespaceIrregularity: number;
}

export interface DocumentQualityResult {
  score: number;
  signals: DocumentQualitySignals;
}

// A page with roughly this many characters of body text is treated as "plenty of
// text" (score contribution saturates at 1) — calibrated against typical single-page
// invoices, not a hard limit.
const EXPECTED_CHARS_PER_PAGE = 500;

export class DocumentQualityService {
  assess(text: string, pageCount: number): DocumentQualityResult {
    const trimmed = text.trim();
    const effectivePages = Math.max(pageCount, 1);

    const charsPerPage = trimmed.length / effectivePages;

    const nonWhitespace = trimmed.replace(/\s/g, "");
    const alphanumericMatches = nonWhitespace.match(/[A-Za-z0-9]/g) ?? [];
    const alphanumericRatio =
      nonWhitespace.length > 0 ? alphanumericMatches.length / nonWhitespace.length : 0;

    const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
    const recognizableWords = tokens.filter((token) => /^[A-Za-z][A-Za-z'-]*$/.test(token));
    const recognizableWordRatio = tokens.length > 0 ? recognizableWords.length / tokens.length : 0;

    const irregularRuns = trimmed.match(/\s{3,}/g) ?? [];
    const whitespaceIrregularity =
      trimmed.length > 0 ? Math.min(irregularRuns.length / (trimmed.length / 100), 1) : 1;

    const charsPerPageScore = Math.min(charsPerPage / EXPECTED_CHARS_PER_PAGE, 1);
    const whitespaceRegularityScore = 1 - whitespaceIrregularity;

    const score =
      charsPerPageScore * 0.3 +
      alphanumericRatio * 0.25 +
      recognizableWordRatio * 0.35 +
      whitespaceRegularityScore * 0.1;

    return {
      score,
      signals: { charsPerPage, alphanumericRatio, recognizableWordRatio, whitespaceIrregularity },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- document-quality`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/document-quality.service.ts services/document-quality.service.test.ts
git commit -m "feat: add DocumentQualityService heuristic quality scoring"
```

---

### Task 3: Env config — `OLLAMA_VISION_MODEL` and `DOCUMENT_QUALITY_THRESHOLD`

**Files:**
- Modify: `config/env.ts`
- Modify: `.env.local`

- [ ] **Step 1: Update `config/env.ts`**

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
});

export const env = schema.parse(process.env);
```

- [ ] **Step 2: Add the new variables to `.env.local`**

Append to `.env.local`:

```
OLLAMA_VISION_MODEL=qwen2.5vl:7b
DOCUMENT_QUALITY_THRESHOLD=0.5
```

- [ ] **Step 3: Verify the app still type-checks and starts**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add config/env.ts .env.local
git commit -m "feat: add OLLAMA_VISION_MODEL and DOCUMENT_QUALITY_THRESHOLD env config"
```

(Note: `.env.local` is gitignored per the existing `.gitignore` — `git add` will report it as ignored and skip it. That's expected; the file is a local convenience for whoever runs this plan, not something committed.)

---

### Task 4: `OllamaService.visionExtractText` — configurable vision-model transcription

**Files:**
- Modify: `services/ollama.service.ts`
- Test: `services/ollama.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { OllamaService } from "@/services/ollama.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("OllamaService.visionExtractText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts images to /api/chat with the configured vision model and returns trimmed text", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "  Transcribed invoice text  " } },
    });

    const service = new OllamaService();
    const result = await service.visionExtractText(["base64imagedata"]);

    expect(result).toBe("Transcribed invoice text");

    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe(`${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`);
    expect(body.model).toBe(env.OLLAMA_VISION_MODEL);
    expect(body.messages[0].images).toEqual(["base64imagedata"]);
  });

  it("accepts a model override", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["img"], "custom-vision-model:7b");

    const [, body] = vi.mocked(axios.post).mock.calls[0];
    expect(body.model).toBe("custom-vision-model:7b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ollama.service`
Expected: FAIL — `service.visionExtractText is not a function`.

- [ ] **Step 3: Implement `visionExtractText`**

Add to `services/ollama.service.ts`, alongside the existing `chatCompletion` method:

```ts
  async visionExtractText(images: string[], model: string = env.OLLAMA_VISION_MODEL): Promise<string> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "Transcribe all readable text from these document page images, in reading order, exactly as it appears. Do not summarize, translate, or add commentary — output only the transcribed text.",
            images,
          },
        ],
        options: { temperature: 0.1 },
      },
      {
        // Vision models processing page images run noticeably slower than the 1.5B
        // text-only chat model on CPU-only Ollama, similar in spirit to why
        // extractInvoiceData needs 240000ms for schema-constrained decoding — 180s
        // leaves headroom for multi-page image input without the schema-decoding cost.
        timeout: 180000,
      }
    );

    return String(response.data?.message?.content ?? "").trim();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ollama.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ollama.service.ts services/ollama.service.test.ts
git commit -m "feat: add OllamaService.visionExtractText with configurable vision model"
```

---

### Task 5: Document classification schema + `OllamaService.classifyDocument`

**Files:**
- Create: `schemas/document-classification.schema.ts`
- Modify: `services/ollama.service.ts`
- Test: `schemas/document-classification.schema.test.ts`
- Test: append to `services/ollama.service.test.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
import { describe, it, expect } from "vitest";
import {
  DocumentClassificationSchema,
  DocumentTypeLabels,
} from "@/schemas/document-classification.schema";

describe("DocumentClassificationSchema", () => {
  it("accepts a valid classification", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "INVOICE",
      confidence: 0.92,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a documentType outside the known label set", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "SPREADSHEET",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0-1", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "INVOICE",
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("exposes INVOICE and OTHER in the label set", () => {
    expect(DocumentTypeLabels).toContain("INVOICE");
    expect(DocumentTypeLabels).toContain("OTHER");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-classification.schema`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schema**

```ts
import { z } from "zod";

export const DocumentTypeLabels = [
  "INVOICE",
  "RECEIPT",
  "PURCHASE_ORDER",
  "CONTRACT",
  "RESUME",
  "OTHER",
] as const;

export const DocumentClassificationSchema = z.object({
  documentType: z.enum(DocumentTypeLabels),
  confidence: z.number().min(0).max(1),
});

export type DocumentClassification = z.infer<typeof DocumentClassificationSchema>;

export const DocumentClassificationJsonSchema = z.toJSONSchema(DocumentClassificationSchema, {
  target: "draft-2020-12",
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- document-classification.schema`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `OllamaService.classifyDocument`**

Append to `services/ollama.service.test.ts`:

```ts
describe("OllamaService.classifyDocument", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("parses a valid schema-constrained classification response", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: JSON.stringify({ documentType: "INVOICE", confidence: 0.88 }) } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some invoice text");

    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({ documentType: "INVOICE", confidence: 0.88 });
  });

  it("returns a failure outcome on invalid JSON", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "not json" } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some text");

    expect(outcome.success).toBe(false);
    expect(outcome.data).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- ollama.service`
Expected: FAIL — `service.classifyDocument is not a function`.

- [ ] **Step 7: Implement `classifyDocument`**

Add to `services/ollama.service.ts`. First add the import at the top of the file:

```ts
import {
  DocumentClassificationSchema,
  DocumentClassificationJsonSchema,
  type DocumentClassification,
} from "@/schemas/document-classification.schema";
```

Add this helper above the `OllamaService` class:

```ts
function buildClassificationPrompt(documentText: string): string {
  return `Classify the document type of the text below into exactly one of: INVOICE, RECEIPT, PURCHASE_ORDER, CONTRACT, RESUME, OTHER. Pick "OTHER" if none of the specific types clearly match. Also give a confidence between 0 and 1 for your classification.

Document text:
"""
${documentText.slice(0, 4000)}
"""`;
}

export interface DocumentClassificationOutcome {
  raw: string;
  success: boolean;
  data: DocumentClassification | null;
  error?: string;
}
```

Add this method to the `OllamaService` class, alongside `extractInvoiceData`:

```ts
  async classifyDocument(
    documentText: string,
    model: string = env.OLLAMA_CHAT_MODEL
  ): Promise<DocumentClassificationOutcome> {
    const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, "");
    const prompt = buildClassificationPrompt(documentText);

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        format: DocumentClassificationJsonSchema,
        options: { temperature: 0.1 },
      },
      {
        // Same reasoning as extractInvoiceData's timeout, but this schema is tiny
        // (two fields) compared to the full invoice schema, so schema-constrained
        // decoding overhead is much smaller — 60s is ample.
        timeout: 60000,
      }
    );

    const raw = String(response.data?.message?.content ?? "");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { raw, success: false, data: null, error: "Model response was not valid JSON." };
    }

    const result = DocumentClassificationSchema.safeParse(parsedJson);
    if (!result.success) {
      return { raw, success: false, data: null, error: result.error.message };
    }

    return { raw, success: true, data: result.data };
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- ollama.service`
Expected: PASS — all `OllamaService` tests green.

- [ ] **Step 9: Commit**

```bash
git add schemas/document-classification.schema.ts schemas/document-classification.schema.test.ts services/ollama.service.ts services/ollama.service.test.ts
git commit -m "feat: add document classification schema and OllamaService.classifyDocument"
```

---

### Task 6: `DocumentClassifierService`

**Files:**
- Create: `services/document-classifier.service.ts`
- Test: `services/document-classifier.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { DocumentClassifierService } from "@/services/document-classifier.service";
import type { OllamaService } from "@/services/ollama.service";

function fakeOllamaService(outcome: {
  success: boolean;
  data: { documentType: string; confidence: number } | null;
}): OllamaService {
  return {
    classifyDocument: vi.fn().mockResolvedValue({ raw: "", ...outcome }),
  } as unknown as OllamaService;
}

describe("DocumentClassifierService", () => {
  it("returns the model's classification when successful", async () => {
    const ollama = fakeOllamaService({
      success: true,
      data: { documentType: "INVOICE", confidence: 0.9 },
    });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("some invoice text");

    expect(result).toEqual({ documentType: "INVOICE", confidence: 0.9 });
  });

  it("falls back to OTHER with zero confidence when classification fails", async () => {
    const ollama = fakeOllamaService({ success: false, data: null });
    const service = new DocumentClassifierService(ollama);

    const result = await service.classify("garbled text");

    expect(result).toEqual({ documentType: "OTHER", confidence: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-classifier`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DocumentClassifierService`**

```ts
import { OllamaService } from "@/services/ollama.service";
import type { DocumentClassification } from "@/schemas/document-classification.schema";

export class DocumentClassifierService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async classify(text: string): Promise<DocumentClassification> {
    const outcome = await this.ollamaService.classifyDocument(text);

    if (!outcome.success || !outcome.data) {
      return { documentType: "OTHER", confidence: 0 };
    }

    return outcome.data;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- document-classifier`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/document-classifier.service.ts services/document-classifier.service.test.ts
git commit -m "feat: add DocumentClassifierService"
```

---

### Task 7: `models/document.model.ts` — extend `DocumentType` and add `classificationConfidence`

**Files:**
- Modify: `models/document.model.ts`

- [ ] **Step 1: Update the `DocumentType` union and interface**

```ts
export type DocumentType =
  | "INVOICE"
  | "RECEIPT"
  | "PURCHASE_ORDER"
  | "CONTRACT"
  | "RESUME"
  | "OTHER"
  | "UNKNOWN";
```

In `IDocument`, add a field after `documentType`:

```ts
export interface IDocument extends mongoose.Document {
  _id: Types.ObjectId;
  emailId: Types.ObjectId;
  documentType: DocumentType;
  classificationConfidence?: number;
  filename?: string;
```

- [ ] **Step 2: Update the Mongoose schema**

```ts
    documentType: {
      type: String,
      enum: ["INVOICE", "RECEIPT", "PURCHASE_ORDER", "CONTRACT", "RESUME", "OTHER", "UNKNOWN"],
      default: "UNKNOWN",
      index: true,
    },
    classificationConfidence: { type: Number },
```

(Insert `classificationConfidence` right after the `documentType` block, before `filename`.)

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add models/document.model.ts
git commit -m "feat: extend DocumentType enum and add classificationConfidence field"
```

---

### Task 8: `pdf-image-renderer` — render PDF pages to PNG images

**Files:**
- Create: `utils/pdf-image-renderer.ts`
- Test: `utils/pdf-image-renderer.test.ts`

- [ ] **Step 1: Write the failing test**

This uses a real sample invoice already in the repo (`data/samples/4.invoice_01_abc_technologies.pdf`) rather than a mock, since rendering is the thing under test — cross-checks the rendered page count against `extractPdfText`'s independently-reported page count so the test doesn't need to hardcode a page number:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
import { extractPdfText } from "@/utils/pdf-text-extractor";

const SAMPLE_PDF = path.resolve("data/samples/4.invoice_01_abc_technologies.pdf");

describe("renderPdfPagesToImages", () => {
  it("renders one PNG image buffer per page", async () => {
    const buffer = await fs.readFile(SAMPLE_PDF);
    const { numPages } = await extractPdfText(buffer);

    const images = await renderPdfPagesToImages(buffer);

    expect(images).toHaveLength(numPages);
    for (const image of images) {
      expect(image.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pdf-image-renderer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

```ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

export async function renderPdfPagesToImages(buffer: Buffer): Promise<Buffer[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    useSystemFonts: true,
  });

  const doc = await loadingTask.promise;
  const images: Buffer[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);

      try {
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext("2d");

        await page.render({
          // pdfjs-dist's render() expects a CanvasRenderingContext2D-shaped object;
          // @napi-rs/canvas's context implements the same drawing API but isn't the
          // DOM lib.d.ts type, hence the cast.
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        images.push(canvas.toBuffer("image/png"));
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return images;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pdf-image-renderer`
Expected: PASS. (If `@napi-rs/canvas`'s `toBuffer` signature differs from what's shown here in the installed version, the test failure will show the actual error — adjust the call to match, the PNG-magic-bytes assertion stays the same either way.)

- [ ] **Step 5: Commit**

```bash
git add utils/pdf-image-renderer.ts utils/pdf-image-renderer.test.ts
git commit -m "feat: add PDF page-to-image renderer using @napi-rs/canvas"
```

---

### Task 9: `VisionExtractionService` — replaces `OcrService`

**Files:**
- Create: `services/vision-extraction.service.ts`
- Test: `services/vision-extraction.service.test.ts`
- (`services/ocr.service.ts` is deleted in Task 10, once its last caller is removed)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { VisionExtractionService } from "@/services/vision-extraction.service";
import type { OllamaService } from "@/services/ollama.service";

vi.mock("@/utils/pdf-image-renderer", () => ({
  renderPdfPagesToImages: vi.fn().mockResolvedValue([Buffer.from("page1"), Buffer.from("page2")]),
}));

function fakeOllamaService(text: string): OllamaService {
  return {
    visionExtractText: vi.fn().mockResolvedValue(text),
  } as unknown as OllamaService;
}

describe("VisionExtractionService", () => {
  it("renders pages, base64-encodes them, and passes them to visionExtractText", async () => {
    const ollama = fakeOllamaService("Recovered invoice text");
    const service = new VisionExtractionService(ollama);

    const result = await service.extractText(Buffer.from("fake pdf bytes"));

    expect(result).toBe("Recovered invoice text");
    expect(ollama.visionExtractText).toHaveBeenCalledWith([
      Buffer.from("page1").toString("base64"),
      Buffer.from("page2").toString("base64"),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vision-extraction`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `VisionExtractionService`**

```ts
import { renderPdfPagesToImages } from "@/utils/pdf-image-renderer";
import { OllamaService } from "@/services/ollama.service";

export class VisionExtractionService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async extractText(pdfBuffer: Buffer): Promise<string> {
    const images = await renderPdfPagesToImages(pdfBuffer);
    const base64Images = images.map((image) => image.toString("base64"));
    return this.ollamaService.visionExtractText(base64Images);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vision-extraction`
Expected: PASS.

- [ ] **Step 5: Commit**

Leave `services/ocr.service.ts` in place for now — `document-ingestion.service.ts` still imports it, and deleting it here would leave the repo non-compiling until Task 10 rewires that import. It gets deleted in Task 10, Step 1, in the same commit that removes the import.

```bash
git add services/vision-extraction.service.ts services/vision-extraction.service.test.ts
git commit -m "feat: add VisionExtractionService alongside the existing OcrService"
```

---

### Task 10: Wire it all into `document-ingestion.service.ts`

**Files:**
- Modify: `services/document-ingestion.service.ts`
- Delete: `services/ocr.service.ts`

This task has no new automated test of its own — `DocumentIngestionService` already has zero test coverage today (it's a thick orchestration method over a real Mongo repository), and adding a full integration-test harness for it is out of scope for this plan. Correctness is verified via the manual steps below plus Task 11's end-to-end checks.

- [ ] **Step 1: Update imports and delete the now-unused `OcrService`**

Replace:

```ts
import { OcrService } from "@/services/ocr.service";
```

with:

```ts
import { DocumentQualityService } from "@/services/document-quality.service";
import { VisionExtractionService } from "@/services/vision-extraction.service";
import { DocumentClassifierService } from "@/services/document-classifier.service";
import type { DocumentClassification } from "@/schemas/document-classification.schema";
```

Then delete `services/ocr.service.ts` — after this file's import is gone, it has no remaining callers.

Run: `Remove-Item services/ocr.service.ts` (or delete via your editor)

- [ ] **Step 2: Update the constructor**

Replace the existing constructor:

```ts
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly indexingService: InvoiceIndexingService = new InvoiceIndexingService(
      repository,
      ollamaService
    ),
    private readonly documentQualityService: DocumentQualityService = new DocumentQualityService(),
    private readonly visionExtractionService: VisionExtractionService = new VisionExtractionService(
      ollamaService
    ),
    private readonly documentClassifierService: DocumentClassifierService = new DocumentClassifierService(
      ollamaService
    )
  ) {}
```

- [ ] **Step 3: Replace the fixed-threshold OCR fallback block**

Replace this block (the `let ocrSucceeded`/`let ocrAvailable` block and the `if (text.trim().length < 200)` check that calls `OcrService`):

```ts
    let ocrSucceeded = false;
    let ocrAvailable = false;

    // If extracted text is too short, attempt OCR fallback
    if (text.trim().length < 200) {
      const ocr = new OcrService();
      try {
        const ocrText = await ocr.ocrPdf(absolutePath);
        ocrAvailable = true;
        if (ocrText && ocrText.trim().length > text.trim().length) {
          text = ocrText;
          ocrSucceeded = true;
        }
      } catch (err) {
        // log and continue with whatever text we have; if OCR is unavailable then mark document for OCR later
        // eslint-disable-next-line no-console
        console.warn("OCR fallback failed:", err instanceof Error ? err.message : err);
      }
    }
```

with:

```ts
    let ocrSucceeded = false;

    const initialQuality = this.documentQualityService.assess(text, numPages ?? 1);

    if (initialQuality.score < env.DOCUMENT_QUALITY_THRESHOLD) {
      try {
        const recoveredText = await this.visionExtractionService.extractText(fileBuffer);
        const recoveredQuality = this.documentQualityService.assess(recoveredText, numPages ?? 1);

        if (recoveredText && recoveredQuality.score > initialQuality.score) {
          text = recoveredText;
          ocrSucceeded = true;
        }
      } catch (err) {
        console.warn(
          "Vision-based text recovery failed:",
          err instanceof Error ? err.message : err
        );
      }
    }
```

- [ ] **Step 4: Replace the fixed-threshold OCR-required check and everything through the first `updateDocumentStatus` call**

Replace this block:

```ts
    if (text.trim().length < 200 && !ocrSucceeded) {
      await this.repository.updateDocumentStatus(document._id, "OCR_REQUIRED", {
        lastError: "OCR is required for this document. Install OCR tooling or use a text-searchable PDF.",
      });

      return {
        email,
        document,
        extraction: null,
        invoice: null,
        message: "OCR is required for this document.",
      };
    }

    const extractionOutcome = await this.ollamaService.extractInvoiceData(text);

    const extraction = await this.repository.createExtraction({
      documentId: document._id,
      status: extractionOutcome.success ? "SUCCEEDED" : "FAILED",
      attempts: 1,
      modelName: env.OLLAMA_CHAT_MODEL,
      rawResponse: extractionOutcome.raw,
      structuredData: extractionOutcome.data ?? {},
      lastError: extractionOutcome.error ?? null,
      metadata: { source: "local-folder" },
    });

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      extractedText: text,
    });

    if (!extractionOutcome.success || !extractionOutcome.data) {
      return {
        email,
        document,
        extraction,
        invoice: null,
        message: "AI extraction failed. The raw model response was preserved on the extraction record for review.",
      };
    }
```

with:

```ts
    const finalQuality = this.documentQualityService.assess(text, numPages ?? 1);

    if (finalQuality.score < env.DOCUMENT_QUALITY_THRESHOLD && !ocrSucceeded) {
      await this.repository.updateDocumentStatus(document._id, "OCR_REQUIRED", {
        lastError:
          "Document quality is too low for extraction. Install a working vision model or use a clearer scan.",
      });

      return {
        email,
        document,
        extraction: null,
        invoice: null,
        classification: null as DocumentClassification | null,
        message: "Document quality is too low for reliable extraction.",
      };
    }

    const classification = await this.documentClassifierService.classify(text);

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      extractedText: text,
      documentType: classification.documentType,
      classificationConfidence: classification.confidence,
    });

    if (classification.documentType !== "INVOICE") {
      return {
        email,
        document,
        extraction: null,
        invoice: null,
        classification,
        message: `Document classified as ${classification.documentType}. Structured extraction is not yet supported for this document type.`,
      };
    }

    const extractionOutcome = await this.ollamaService.extractInvoiceData(text);

    const extraction = await this.repository.createExtraction({
      documentId: document._id,
      status: extractionOutcome.success ? "SUCCEEDED" : "FAILED",
      attempts: 1,
      modelName: env.OLLAMA_CHAT_MODEL,
      rawResponse: extractionOutcome.raw,
      structuredData: extractionOutcome.data ?? {},
      lastError: extractionOutcome.error ?? null,
      metadata: { source: "local-folder" },
    });

    if (!extractionOutcome.success || !extractionOutcome.data) {
      return {
        email,
        document,
        extraction,
        invoice: null,
        classification,
        message: "AI extraction failed. The raw model response was preserved on the extraction record for review.",
      };
    }
```

(This removes the now-redundant second `updateDocumentStatus(..., "EXTRACTED", { extractedText: text })` call, since classification already sets status to `EXTRACTED` with `extractedText` earlier in the flow.)

- [ ] **Step 5: Update the final return of `processLocalDocument` to include `classification`**

Replace:

```ts
    return {
      email,
      document,
      extraction,
      invoice,
    };
  }
```

with:

```ts
    return {
      email,
      document,
      extraction,
      invoice,
      classification,
    };
  }
```

- [ ] **Step 6: Update `reextractDocument` to classify and gate the same way**

Replace the return type and body of `reextractDocument`:

```ts
  async reextractDocument(documentId: Types.ObjectId | string): Promise<{
    success: boolean;
    document: IDocument | null;
    extraction: IExtraction | null;
    invoice: IInvoice | null;
    classification?: DocumentClassification | null;
    error?: string;
  }> {
    const document = await this.repository.findDocumentById(documentId);
    if (!document) {
      return { success: false, document: null, extraction: null, invoice: null, error: "Document not found" };
    }

    const textToExtract = document.extractedText ?? "Invoice details are unavailable.";

    const classification = await this.documentClassifierService.classify(textToExtract);

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      documentType: classification.documentType,
      classificationConfidence: classification.confidence,
    });

    if (classification.documentType !== "INVOICE") {
      return {
        success: false,
        document,
        extraction: null,
        invoice: null,
        classification,
        error: `Document classified as ${classification.documentType}. Structured extraction is not yet supported for this document type.`,
      };
    }

    const outcome = await this.ollamaService.extractInvoiceData(textToExtract);

    const extraction = await this.repository.createExtraction({
      documentId: document._id,
      status: outcome.success ? "SUCCEEDED" : "FAILED",
      attempts: 1,
      modelName: env.OLLAMA_CHAT_MODEL,
      rawResponse: outcome.raw,
      structuredData: outcome.data ?? {},
      lastError: outcome.error ?? null,
      metadata: { source: "reindex" },
    });

    await this.repository.updateDocumentStatus(document._id, "EXTRACTED", {
      extractedText: textToExtract,
    });

    if (!outcome.success || !outcome.data) {
      return {
        success: false,
        document,
        extraction,
        invoice: null,
        classification,
        error: outcome.error ?? "AI extraction failed",
      };
    }

    const invoice = await this.repository.upsertInvoiceByDocumentId({
      documentId: document._id,
      ...mapInvoiceExtractionToInvoiceFields(outcome.data),
      status: "EXTRACTED",
      metadata: { source: "reindex" },
    });

    if (!invoice) {
      return {
        success: false,
        document,
        extraction,
        invoice: null,
        classification,
        error: "Failed to upsert invoice record.",
      };
    }

    await this.indexingService.replaceChunksAndEmbeddings(document._id, invoice._id, outcome.data, {
      source: "reindex",
    });

    return { success: true, document, extraction, invoice, classification };
  }
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If `numPages` is flagged as possibly `null` where `numPages ?? 1` isn't already applied, double check both quality-assessment call sites use `numPages ?? 1` (it's declared as `let numPages: number | null = null;` earlier in the file).

- [ ] **Step 8: Commit**

```bash
git add services/document-ingestion.service.ts
git add services/ocr.service.ts
git commit -m "feat: wire quality gate, vision extraction, and classification into ingestion"
```

(The second `git add` stages the deletion of `services/ocr.service.ts` — `git status` should show `deleted: services/ocr.service.ts` before this commit.)

---

### Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests across every `.test.ts` file created in Tasks 2, 5, 6, 8, 9 pass.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Regression-check the working text-native path**

Start Ollama locally, confirm `qwen2.5:1.5b` and `nomic-embed-text` are pulled (`ollama list`). Start the dev server (`npm run dev`), then ingest one of the existing text-native sample invoices, e.g. via:

```bash
curl -X POST http://localhost:3000/api/documents/ingest -H "Content-Type: application/json" -d "{\"sourcePath\": \"data/samples/4.invoice_01_abc_technologies.pdf\"}"
```

Expected: response has `"success": true`, `classification.documentType` is `"INVOICE"`, and `invoice` is populated — same outcome as before this plan, confirming no regression on the path that already worked.

- [ ] **Step 4: Verify the vision-model fallback**

Pull a vision model if not already present:

Run: `ollama pull qwen2.5vl:7b`

Find or create a scanned/image-only PDF (no text layer) and ingest it the same way as Step 3. Expected: server logs show the vision-recovery path was taken (the `console.warn` in Step 3 of Task 10 does NOT fire, meaning `visionExtractText` succeeded), and the response's `extraction`/`invoice` reflect real extracted data instead of an `OCR_REQUIRED` status.

- [ ] **Step 5: Verify the vision model is swappable**

Change `OLLAMA_VISION_MODEL` in `.env.local` to a different pulled vision model (or leave as-is and just confirm via `npx tsc --noEmit` plus a quick read of `ollama.service.ts` that nothing hardcodes `qwen2.5vl:7b` anywhere outside the env default). Restart the dev server and repeat Step 4 — confirm the new model is used with no code changes required.

- [ ] **Step 6: Verify classification gating on a non-invoice document**

Ingest a non-invoice text document (e.g. a plain-text resume or contract saved as `.txt`, since the ingestion path also accepts non-PDF files via `fileBuffer.toString("utf-8")`). Expected: response's `classification.documentType` is not `"INVOICE"`, `invoice` is `null`, and `message` reads "Document classified as ... Structured extraction is not yet supported for this document type."

- [ ] **Step 7: Confirm `/search` and `/chat` are unaffected**

Run the existing search and chat flows (`/search`, `/chat` pages, or their underlying `/api/search` and `/api/chat` routes) against already-indexed invoices from Step 3. Expected: identical behavior to before this plan — neither `search.service.ts` nor `rag.service.ts` were touched.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "chore: verify vision extraction, quality gating, and classification end-to-end"
```
