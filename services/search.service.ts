import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { SiglipService } from "@/services/siglip.service";
import { cosineSimilarity } from "@/utils/vector";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
// SigLIP2's text tower (short-caption-oriented, ~64 token limit) produces a much
// higher and noisier baseline similarity than nomic-embed-text did — cosine similarity
// between unrelated short text embeddings routinely lands in the 0.4-0.7 range rather
// than 0.3-0.45 (stronger anisotropy for short strings). 0.73 is calibrated against
// real measurements against re-indexed SigLIP2 data: two different nonsense queries
// topped out at 0.45 and 0.70 across all chunk types (noise ceiling ~0.70), while a
// genuinely relevant query's weakest reasonable match (a real line-item chunk, not one
// of the near-content-free single-word tax-label chunks that score anomalously high
// for any query) started at 0.78.
const DEFAULT_THRESHOLD = 0.73;

// A fixed floor alone isn't reliable: different nonsense queries land at different
// points on the noise floor (measured 0.45 and 0.70 for two unrelated queries), just
// above or below any single cutoff. What reliably differs is the SHAPE of the score
// distribution: a real match has its top score standing clearly apart from the mean of
// all candidate scores (measured gap of top-score-minus-mean ~0.52 for a genuine match
// vs ~0.23 and ~0.36 for two different nonsense queries). MIN_SIGNAL_GAP requires that
// separation before trusting a borderline top score. HIGH_CONFIDENCE_MARGIN skips the
// gap check entirely when the top score is already well clear of the threshold —
// several chunks scoring uniformly high (e.g. a broad query matching a whole invoice)
// is a legitimate result, not noise, and shouldn't be vetoed just for lacking a single
// standout leader. Note: SigLIP2's short-text embedding space compresses scores into a
// narrower, higher band than nomic-embed-text did, so the margin between threshold and
// the observed genuine-match top score (~0.98) is wider in absolute terms than before;
// this hasn't been validated against a live example of a borderline-but-real match
// specifically in the gap-check band (threshold to threshold+margin), since the one
// real match measured here scored well above that band.
const MIN_SIGNAL_GAP = 0.4;
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
