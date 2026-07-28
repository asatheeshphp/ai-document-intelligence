import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { SiglipService } from "@/services/siglip.service";
import { cosineSimilarity } from "@/utils/vector";
import { lexicalOverlapScore } from "@/utils/lexical-score";
import { extractDateRangeFromQuery } from "@/utils/date-range-from-query";

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
//   English vendor-name query, gap only (English, exact vendor name in query): 0.0343 - 0.0732
//     ** IMPORTANT: gap value alone is misleading here. In all 4 English vendor-name
//     ** queries tested, the top-ranked chunk did NOT belong to the target invoice —
//     ** e.g. querying "CloudNova" returned Medicare's chunk as #1 (CloudNova was #8),
//     ** and querying "Medicare" returned CloudNova's chunk as #1. Top-1 ranking
//     ** accuracy for plain English queries was unreliable and was a SEPARATE problem
//     ** from the threshold/gap values below — this recalibration did not fix it, only
//     ** the multilingual zero-results bug it was tasked with. It is now addressed
//     ** separately by LEXICAL_BOOST below (added 2026-07-27) — see that constant's
//     ** comment for how.
//   genuine multilingual match (Spanish query -> CloudNova invoice, correct top-1):  0.0296
//   genuine multilingual match (Hindi query -> Medicare invoice, correct top-1):     0.0283
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

// FIX (2026-07-27): the top-1 English ranking bug documented above — "CloudNova" ranking
// Medicare's chunk #1, a verbatim invoice number not ranking its own chunk in the top 5 —
// is a lexical-matching gap, not a mistuned threshold: SigLIP2's text tower wasn't trained
// to separate short, structurally-similar, template-heavy invoice text on exact keyword
// overlap. LEXICAL_BOOST adds a literal-overlap score (see utils/lexical-score.ts) on top
// of cosine similarity so a verbatim vendor name / invoice number / line item decisively
// outranks noise regardless of vector-space anisotropy. It's additive and zero for queries
// with no literal overlap, so multilingual and nonsense-query behavior (calibrated above)
// is unaffected — this only changes ranking when the query's own words actually appear in
// the candidate chunk.
const LEXICAL_BOOST = 0.5;

// A single invoice can have 15-20+ chunks (per-line-item/per-tax-entry chunking), and
// once one invoice is clearly the best match, most of its chunks tend to score close
// together — without a cap, one invoice can fill every slot up to topK with its own
// near-duplicate/low-signal fragments (bare "CGST"/"SGST" tax-type chunks, an unrelated
// line item), crowding out other candidate invoices and reading as repetitive "duplicate
// data" to the user even though it's one invoice, not a duplicate. Capping keeps results
// diverse across invoices while preserving global score order.
const MAX_RESULTS_PER_INVOICE = 3;

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

    // Search is pure semantic similarity — nothing about it understands "July" unless a
    // chunk happens to resemble that phrasing. A month named in the query (e.g. "billed
    // in July") is turned into an actual invoiceDate range here, reusing the same
    // explicit-filter mechanism below, so a query naming a month can't surface invoices
    // from unrelated months just because they scored well on general content.
    const inferredDateRange = extractDateRangeFromQuery(input.query);
    const effectiveDateFrom = filters?.invoiceDateFrom ?? inferredDateRange?.from.toISOString();
    const effectiveDateTo = filters?.invoiceDateTo ?? inferredDateRange?.to.toISOString();

    if (filters?.vendorName || filters?.customerName || effectiveDateFrom || effectiveDateTo) {
      const invoiceFilter: Record<string, unknown> = {};

      if (filters?.vendorName) {
        invoiceFilter.vendorName = { $regex: filters.vendorName, $options: "i" };
      }
      if (filters?.customerName) {
        invoiceFilter.customerName = { $regex: filters.customerName, $options: "i" };
      }
      if (effectiveDateFrom || effectiveDateTo) {
        const range: Record<string, Date> = {};
        if (effectiveDateFrom) range.$gte = new Date(effectiveDateFrom);
        if (effectiveDateTo) range.$lte = new Date(effectiveDateTo);
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

    // Chunk text is needed for every candidate (not just the final topK) so the lexical
    // boost below can affect ranking, not just re-order results that already passed a
    // vector-only cut.
    const candidateChunkIds = candidates
      .map((embedding) => embedding.chunkId)
      .filter((id): id is Types.ObjectId => Boolean(id));

    const candidateChunks =
      candidateChunkIds.length > 0 ? await this.repository.findChunksByIds(candidateChunkIds) : [];

    const chunkById = new Map(candidateChunks.map((chunk) => [chunk._id.toString(), chunk]));

    const allScored = candidates.map((embedding) => {
      const vectorScore = cosineSimilarity(queryVector, embedding.embeddingVector);
      const chunkText = embedding.chunkId ? chunkById.get(embedding.chunkId.toString())?.text ?? "" : "";
      const lexicalScore = lexicalOverlapScore(input.query, chunkText);

      return { embedding, score: vectorScore + LEXICAL_BOOST * lexicalScore };
    });

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

    const sortedByScore = allScored.filter((item) => item.score >= threshold).sort((a, b) => b.score - a.score);

    const chunksPerInvoice = new Map<string, number>();
    const scored: typeof sortedByScore = [];
    for (const item of sortedByScore) {
      const invoiceKey = item.embedding.invoiceId.toString();
      const countSoFar = chunksPerInvoice.get(invoiceKey) ?? 0;
      if (countSoFar >= MAX_RESULTS_PER_INVOICE) continue;

      chunksPerInvoice.set(invoiceKey, countSoFar + 1);
      scored.push(item);
      if (scored.length >= topK) break;
    }

    const invoiceIds = Array.from(new Set(scored.map((item) => item.embedding.invoiceId.toString())));
    const invoices = await this.repository.findInvoicesByIds(invoiceIds);
    const invoiceById = new Map(invoices.map((invoice) => [invoice._id.toString(), invoice]));

    const results: SearchResultItem[] = scored.map((item) => {
      const invoice = invoiceById.get(item.embedding.invoiceId.toString()) ?? null;
      const chunk = item.embedding.chunkId ? chunkById.get(item.embedding.chunkId.toString()) : undefined;

      return {
        invoiceId: item.embedding.invoiceId.toString(),
        documentId: item.embedding.documentId.toString(),
        chunkId: item.embedding.chunkId?.toString(),
        chunkType: item.embedding.chunkType,
        chunkText: chunk?.text ?? "",
        // item.score (vector similarity + LEXICAL_BOOST) is used unclamped for ranking/
        // threshold/gap-check above, but a strong lexical match can push it past 1.0 —
        // clamp only here, for display, so the UI's "N% match" never shows over 100%.
        score: Math.min(item.score, 1),
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
