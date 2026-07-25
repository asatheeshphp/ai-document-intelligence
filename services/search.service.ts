import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { SiglipService } from "@/services/siglip.service";
import { cosineSimilarity } from "@/utils/vector";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
// ---------------------------------------------------------------------------------
// RE-CALIBRATION NOTE (2026-07-25, Task 7 end-to-end verification):
//
// Task 6's thresholds (0.73 / 0.4 gap / 0.15 margin) were calibrated against a corpus
// of 1-2 invoices. Once the corpus grew to 8 invoices / 113 chunks, MIN_SIGNAL_GAP=0.4
// caused /api/search to return ZERO results for genuinely correct matches, including
// every multilingual query tested — the exact bug this migration exists to fix.
//
// Re-measuring against the larger corpus (queries run via the real SigLIP2 sidecar
// against all 113 indexed chunks across 8 invoices — ABC Technologies, GreenLeaf,
// Zenith Trading, ABC Exports, two Express Cargo & Logistics invoices, Medicare Pharma,
// CloudNova Software) surfaced something worse than a mistuned constant: at this scale
// SigLIP2's short-text tower does not reliably separate relevant from irrelevant
// content at all, in either the raw score or the top-vs-mean gap.
//
// Measured top-score-minus-mean gaps (over all 113 candidates):
//   genuine invoice-specific match (English, exact vendor name in query): 0.0343 - 0.0732
//   genuine multilingual match (Spanish query -> CloudNova invoice):      0.0296
//   genuine multilingual match (Hindi query -> Medicare invoice):        0.0283
//   nonsense query 1 ("recipe for chocolate lava cake dessert"):          0.0268
//   nonsense query 2 ("quantum physics of black holes..."):               0.0307
// Sorted: nonsense1 (0.0268) < Hindi-genuine (0.0283) < Spanish-genuine (0.0296) <
// nonsense2 (0.0307). The genuine and nonsense gap values are *interleaved* — no
// single MIN_SIGNAL_GAP cutoff can separate them, because the underlying distributions
// overlap, not because the wrong number was picked.
//
// The same is true of raw top scores: nonsense2 topped out at 0.8006, while the Hindi
// multilingual genuine match topped out at only 0.7889 — LOWER than a nonsense query.
// A literal invoice number ("CNS-2026-501") and a verbatim line-item string ("AI
// Platform License") used as queries did not even rank their own source chunk in the
// top 5 of all 113 candidates; unrelated chunks scored higher (0.996 vs an exact
// verbatim match). This indicates SigLIP2's text tower is producing near-degenerate,
// highly anisotropic embeddings for this kind of short, structurally-similar,
// template-heavy invoice text (e.g. "Customer: X Address: Y", repeated tax-label
// chunks like "CGST"/"SGST" that are byte-identical across invoices) — there just
// isn't much usable signal magnitude to threshold on, independent of what threshold
// value is chosen.
//
// Given that, DEFAULT_THRESHOLD and MIN_SIGNAL_GAP below are a best-effort compromise,
// not a clean fix: they are set to avoid rejecting the weakest genuine match actually
// measured (Hindi multilingual, top score 0.7889, gap 0.0283) since a silent
// zero-result response for a correct match was the specific, worse failure mode this
// recalibration was tasked with fixing. The cost is that nonsense queries whose noise
// ceiling happens to land above ~0.78 (measured nonsense2 example: 0.8006) will still
// return spurious low-quality results. This is a known, accepted limitation of the
// current approach — genuinely fixing nonsense-rejection would require either a
// different embedding model with less anisotropy for short/structured text, a hybrid
// keyword+vector pre-filter, or de-duplicating the boilerplate/template chunks that
// are polluting the score distribution — none of which are in scope for a
// threshold-only recalibration.
const DEFAULT_THRESHOLD = 0.78;

// See note above: at this corpus size the gap between a genuine top score and the
// mean of all 113 candidates is small (0.028 - 0.073) and overlaps with the gap
// produced by nonsense queries (0.027 - 0.031). MIN_SIGNAL_GAP is set just below the
// lowest measured genuine-match gap (Hindi multilingual, 0.0283) so it does not reject
// real cross-document/multilingual matches; it will not reliably reject nonsense
// queries whose gap also falls in this band (e.g. nonsense2 measured 0.0307, which
// would have passed a gap check set anywhere below that value). HIGH_CONFIDENCE_MARGIN
// is unchanged — when the top score already clears threshold+margin the gap check is
// skipped, matching the several-chunks-score-uniformly-high case described in Task 6.
const MIN_SIGNAL_GAP = 0.025;
const HIGH_CONFIDENCE_MARGIN = 0.15;
const MIN_CANDIDATES_FOR_GAP_CHECK = 3;

export interface SearchFilters {
  vendorName?: string;
  customerName?: string;
  invoiceDateFrom?: string;
  invoiceDateTo?: string;
  chunkType?: string;
}

export interface SearchInput {
  query: string;
  topK?: number;
  threshold?: number;
  filters?: SearchFilters;
}

export interface SearchResultItem {
  invoiceId: string;
  documentId: string;
  chunkId?: string;
  chunkType?: string;
  chunkText: string;
  score: number;
  invoice: {
    invoiceNumber?: string;
    vendorName?: string;
    customerName?: string;
    invoiceDate?: Date;
    totalAmount?: number;
  } | null;
}

export interface SearchOutput {
  results: SearchResultItem[];
  queryVectorDimension: number;
}

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

    let invoiceIdFilter: Types.ObjectId[] | null = null;

    if (filters?.vendorName || filters?.customerName || filters?.invoiceDateFrom || filters?.invoiceDateTo) {
      const invoiceFilter: Record<string, unknown> = {};

      if (filters.vendorName) {
        invoiceFilter.vendorName = { $regex: filters.vendorName, $options: "i" };
      }
      if (filters.customerName) {
        invoiceFilter.customerName = { $regex: filters.customerName, $options: "i" };
      }
      if (filters.invoiceDateFrom || filters.invoiceDateTo) {
        const range: Record<string, Date> = {};
        if (filters.invoiceDateFrom) range.$gte = new Date(filters.invoiceDateFrom);
        if (filters.invoiceDateTo) range.$lte = new Date(filters.invoiceDateTo);
        invoiceFilter.invoiceDate = range;
      }

      const matchingInvoices = await this.repository.listInvoices(invoiceFilter);
      invoiceIdFilter = matchingInvoices.map((invoice) => invoice._id);

      if (invoiceIdFilter.length === 0) {
        return { results: [], queryVectorDimension: queryVector.length };
      }
    }

    const embeddings = invoiceIdFilter
      ? await this.vectorRepository.findEmbeddingsByInvoiceIds(invoiceIdFilter)
      : await this.vectorRepository.findAllEmbeddings();

    let candidates = embeddings.filter(
      (embedding) => Array.isArray(embedding.embeddingVector) && embedding.embeddingVector.length > 0
    );

    if (filters?.chunkType) {
      candidates = candidates.filter((embedding) => embedding.chunkType === filters.chunkType);
    }

    const allScored = candidates.map((embedding) => ({
      embedding,
      score: cosineSimilarity(queryVector, embedding.embeddingVector),
    }));

    if (allScored.length === 0) {
      return { results: [], queryVectorDimension: queryVector.length };
    }

    const topScore = Math.max(...allScored.map((item) => item.score));

    if (allScored.length >= MIN_CANDIDATES_FOR_GAP_CHECK && topScore < threshold + HIGH_CONFIDENCE_MARGIN) {
      const meanScore = allScored.reduce((sum, item) => sum + item.score, 0) / allScored.length;
      const signalGap = topScore - meanScore;

      if (signalGap < MIN_SIGNAL_GAP) {
        return { results: [], queryVectorDimension: queryVector.length };
      }
    }

    const scored = allScored
      .filter((item) => item.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const invoiceIds = Array.from(new Set(scored.map((item) => item.embedding.invoiceId.toString())));
    const chunkIds = scored
      .map((item) => item.embedding.chunkId)
      .filter((id): id is Types.ObjectId => Boolean(id));

    const [invoices, chunks] = await Promise.all([
      this.repository.findInvoicesByIds(invoiceIds),
      chunkIds.length > 0 ? this.repository.findChunksByIds(chunkIds) : Promise.resolve([]),
    ]);

    const invoiceById = new Map(invoices.map((invoice) => [invoice._id.toString(), invoice]));
    const chunkById = new Map(chunks.map((chunk) => [chunk._id.toString(), chunk]));

    const results: SearchResultItem[] = scored.map((item) => {
      const invoice = invoiceById.get(item.embedding.invoiceId.toString()) ?? null;
      const chunk = item.embedding.chunkId ? chunkById.get(item.embedding.chunkId.toString()) : undefined;

      return {
        invoiceId: item.embedding.invoiceId.toString(),
        documentId: item.embedding.documentId.toString(),
        chunkId: item.embedding.chunkId?.toString(),
        chunkType: item.embedding.chunkType,
        chunkText: chunk?.text ?? "",
        score: item.score,
        invoice: invoice
          ? {
              invoiceNumber: invoice.invoiceNumber,
              vendorName: invoice.vendorName,
              customerName: invoice.customerName,
              invoiceDate: invoice.invoiceDate,
              totalAmount: invoice.totalAmount,
            }
          : null,
      };
    });

    return { results, queryVectorDimension: queryVector.length };
  }
}
