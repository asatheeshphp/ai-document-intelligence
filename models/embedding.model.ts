import mongoose, { Schema, type Types } from "mongoose";

export type EmbeddingStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface IEmbedding extends mongoose.Document {
  _id: Types.ObjectId;
  invoiceId: Types.ObjectId;
  documentId: Types.ObjectId;
  chunkId?: Types.ObjectId;
  chunkType?: string;
  embeddingModel: string;
  embeddingVector: number[];
  sourceTextHash?: string;
  status: EmbeddingStatus;
  lastError?: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const EmbeddingSchema = new Schema<IEmbedding>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true, index: true },
    chunkId: { type: Schema.Types.ObjectId, ref: "Chunk", required: false, index: true },
    chunkType: { type: String },
    embeddingModel: { type: String, required: true },
    embeddingVector: { type: [Number], required: true },
    sourceTextHash: { type: String },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "FAILED"],
      default: "PENDING",
    },
    lastError: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "embeddings" }
);

export const Embedding =
  mongoose.models.Embedding || mongoose.model<IEmbedding>("Embedding", EmbeddingSchema);
