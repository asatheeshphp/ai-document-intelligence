import type { Types } from "mongoose";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { VectorRepository } from "@/repositories/vector.repository";
import { SiglipService } from "@/services/siglip.service";
import { cosineSimilarity } from "@/utils/vector";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
// Cosine similarity between unrelated text embeddings still lands ~0.3-0.45 (embedding
// space anisotropy, not a real match) — 0 let every query return results regardless of
// relevance. 0.45 is calibrated against real measurements: a nonsense query topped out
// at 0.43 across all chunk types, while a genuinely relevant query's weakest reasonable
// match started at 0.52.
const DEFAULT_THRESHOLD = 0.45;

// A fixed floor alone isn't reliable: different nonsense queries land at different
// points on the noise floor (measured 0.43 and 0.47 for two unrelated queries), just
// above or below any single cutoff. What reliably differs is the SHAPE of the score
// distribution: a real match has one (or a few) chunks standing clearly apart from the
// rest (measured gap ~0.15 for a genuine match vs ~0.05-0.07 for two different nonsense
// queries). MIN_SIGNAL_GAP requires that separation before trusting a borderline top
// score. HIGH_CONFIDENCE_MARGIN skips the gap check entirely when the top score is
// already well clear of the threshold — several chunks scoring uniformly high (e.g. a
// broad query matching a whole invoice) is a legitimate result, not noise, and
// shouldn't be vetoed just for lacking a single standout leader.
const MIN_SIGNAL_GAP = 0.08;
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
