import { type Types } from "mongoose";
import { BaseRepository } from "@/repositories/base.repository";
import { Embedding, type IEmbedding } from "@/models/embedding.model";

export interface VectorSearchResult {
  embedding: IEmbedding;
  score: number;
}

export class VectorRepository extends BaseRepository<unknown> {
  async findAllEmbeddings(): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find({ status: "COMPLETED" }).exec();
    });
  }

  async findEmbeddingsByIds(ids: Array<string | Types.ObjectId>): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find({ _id: { $in: ids } }).exec();
    });
  }

  async findEmbeddingsByInvoiceIds(invoiceIds: Array<string | Types.ObjectId>): Promise<IEmbedding[]> {
    return this.withConnection(async () => {
      return Embedding.find({ invoiceId: { $in: invoiceIds }, status: "COMPLETED" }).exec();
    });
  }
}
