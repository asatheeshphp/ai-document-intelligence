import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { E5Service } from "@/services/e5.service";
import { OllamaService } from "@/services/ollama.service";
import { cosineSimilarity } from "@/utils/vector";
import { lexicalOverlapScore } from "@/utils/lexical-score";
import { extractDateRangeFromQuery } from "@/utils/date-range-from-query";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
// ---------------------------------------------------------------------------------
// CALIBRATION NOTE (2026-07-28, SigLIP2 -> E5 embedding migration):
//
// A 40-query benchmark (10 intents x English/Spanish/Tamil/Telugu) run before this
// migration found SigLIP2's raw text-to-text discrimination too weak to trust even in
// English (3/10 raw recall@1, 0.0085 average score margin between the top two
// candidates, genuine and nonsense-query scores fully interleaved). Full findings are
// in that benchmark's own output; the short version is SigLIP2 is trained for
// image<->text matching, not text<->text retrieval, and it showed.
//
// multilingual-e5-base was benchmarked head-to-head on the identical 40 queries before
// switching: 9/10 English recall@1, 7/10 Spanish, 4/10 Tamil, 4/10 Telugu, and — the
// most direct test of "does this model understand meaning, not just match words" —
// a perfect 4/4 on English queries phrased with zero words in common with the target
// text (up from 2/4 for SigLIP2).
//
// After migrating (re-embedding all 9 invoices / 103 chunks with E5), thresholds were
// re-measured the same way as the original SigLIP2 calibration — genuine queries
// (literal and paraphrased) vs. nonsense queries, over the full re-embedded corpus:
//   genuine top scores:   0.8391 - 0.8815  (lowest: office-furniture paraphrase)
//   genuine top-vs-mean gaps: 0.0649 - 0.1158
//   nonsense top scores:  0.7746 - 0.7999  ("chocolate lava cake" / "quantum physics")
//   nonsense top-vs-mean gaps: 0.0355 - 0.0379
// Unlike SigLIP2's interleaved distributions, genuine and nonsense scores here are
// cleanly separated with no overlap — the lowest genuine top score (0.8391) sits a
// clear 0.0392 above the highest nonsense top score (0.7999), and the same holds for
// the gap measure (0.0649 vs 0.0379). DEFAULT_THRESHOLD and MIN_SIGNAL_GAP below sit in
// those gaps, favoring not rejecting a genuine match (same asymmetric-risk reasoning as
// before: a silent empty result for a correct query is worse than occasionally letting
// a low-quality nonsense match through).
const DEFAULT_THRESHOLD = 0.8;

// Set just above the measured nonsense gap ceiling (0.0379) and comfortably below the
// lowest measured genuine gap (0.0649) — see note above for the full measurement.
// HIGH_CONFIDENCE_MARGIN is unchanged from the SigLIP2 era: no genuine query measured
// so far clears threshold + 0.15, so the gap check still runs for every real query,
// which is the intended behavior.
const MIN_SIGNAL_GAP = 0.045;
const HIGH_CONFIDENCE_MARGIN = 0.15;
const MIN_CANDIDATES_FOR_GAP_CHECK = 3;

// Originally added to fix a SigLIP2-era top-1 ranking bug (exact vendor names/invoice
// numbers not reliably ranking their own chunk first) and kept after the E5 migration:
// no embedding model reliably guarantees an exact identifier (invoice number, literal
// vendor name) outranks semantically-similar-but-wrong content — that's a keyword-match
// problem, not a semantic one. LEXICAL_BOOST adds a literal-overlap score (see
// utils/lexical-score.ts) on top of cosine similarity. It's additive and zero for
// queries with no literal overlap, so it never affects multilingual or paraphrased
// queries — only ones where the query's own words actually appear in the chunk.
const LEXICAL_BOOST = 0.5;

// A single invoice can have 15-20+ chunks (per-line-item/per-tax-entry chunking).
// Without a cap, one invoice can fill every slot up to topK with its own fragments —
// including near-noise ones like a bare tax-type chunk — crowding out other candidates
// and reading as repetitive "duplicate data" even though it's one invoice, not a
// duplicate (reported live during the SigLIP2 era). Kept at 1 after the E5 migration:
// E5's much cleaner score separation (see calibration note above) makes this less
// likely to matter, but a wrong invoice surfacing as one visibly weaker result is still
// a better default than several, and there's no measured evidence yet that a higher
// cap is safe on this corpus.
const MAX_RESULTS_PER_INVOICE = 1;

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
    private readonly e5Service: E5Service = new E5Service(),
    private readonly ollamaService: OllamaService = new OllamaService()
  ) {}

  /**
   * Runs the primary search; if it finds nothing AND the query isn't plain ASCII
   * (i.e. it's plausibly non-English), retries once against an English translation.
   *
   * This exists because of a measured, structural gap, not a guess: a genuine,
   * non-English query with no literal anchor (no shared proper noun/number with the
   * target text) produces E5 scores that are fully interleaved with nonsense-query
   * scores in every language tested — no threshold value separates them (see
   * DEFAULT_THRESHOLD's calibration note). Confirmed live: Tamil/Telugu queries with no
   * anchor ("12-ton shipment", "diesel fuel expenses", "Coimbatore to Chennai
   * transport") returned nothing, while the same intents WITH an anchor (an amount, a
   * brand name) worked fine. Translating to English turns that into an English-to-
   * English comparison, which measured reliably — same task E5 is actually good at.
   *
   * Only a fallback, not automatic translation of every query: a query that already
   * found results, or that's already plain ASCII (almost certainly English, so
   * translation would just return it unchanged), skips the extra Ollama round trip.
   */
  async search(input: SearchInput): Promise<SearchOutput> {
    const topK = input.topK && input.topK > 0 ? Math.min(Math.floor(input.topK), MAX_TOP_K) : DEFAULT_TOP_K;
    const threshold = input.threshold ?? DEFAULT_THRESHOLD;
    const filters = input.filters;

    const primary = await this.runSearch(input.query, topK, threshold, filters);
    if (primary.results.length > 0) return primary;

    const isPlainAscii = /^[\x00-\x7F]*$/.test(input.query);
    if (isPlainAscii) return primary;

    const translated = await this.ollamaService.translateToEnglish(input.query).catch(() => null);
    if (!translated || translated.trim().toLowerCase() === input.query.trim().toLowerCase()) {
      return primary;
    }

    return this.runSearch(translated, topK, threshold, filters);
  }

  private async runSearch(
    query: string,
    topK: number,
    threshold: number,
    filters: SearchFilters | undefined
  ): Promise<SearchOutput> {
    const queryVector = await this.e5Service.embedText(query, "query");

    let invoiceIdFilter: Types.ObjectId[] | null = null;

    // Search is pure semantic similarity — nothing about it understands "July" unless a
    // chunk happens to resemble that phrasing. A month named in the query (e.g. "billed
    // in July") is turned into an actual invoiceDate range here, reusing the same
    // explicit-filter mechanism below, so a query naming a month can't surface invoices
    // from unrelated months just because they scored well on general content.
    const inferredDateRange = extractDateRangeFromQuery(query);
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
      const lexicalScore = lexicalOverlapScore(query, chunkText);

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
