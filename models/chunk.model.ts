import mongoose, { Schema, type Types } from "mongoose";

export type ChunkType =
  | "header"
  | "supplier"
  | "customer"
  | "line_items"
  | "taxes"
  | "payment"
  | "notes"
  | "footer"
  | "other";

export interface IChunk extends mongoose.Document {
  _id: Types.ObjectId;
  invoiceId: Types.ObjectId;
  documentId: Types.ObjectId;
  chunkType: ChunkType;
  text: string;
  startOffset: number;
  endOffset: number;
  tokenCount?: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const ChunkSchema = new Schema<IChunk>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true, index: true },
    chunkType: {
      type: String,
      enum: ["header", "supplier", "customer", "line_items", "taxes", "payment", "notes", "footer", "other"],
      default: "other",
      index: true,
    },
    text: { type: String, required: true },
    startOffset: { type: Number, required: true },
    endOffset: { type: Number, required: true },
    tokenCount: { type: Number },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "chunks" }
);

export const Chunk = mongoose.models.Chunk || mongoose.model<IChunk>("Chunk", ChunkSchema);
