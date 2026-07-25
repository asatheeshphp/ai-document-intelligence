import mongoose, { Schema, type Types } from "mongoose";

export type ExtractionStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "RETRYING";

export interface IExtraction extends mongoose.Document {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  extractionType: string;
  provider: string;
  status: ExtractionStatus;
  attempts: number;
  modelName?: string;
  rawResponse?: string;
  structuredData?: Record<string, unknown>;
  inputTextHash?: string;
  retryAt?: Date | null;
  lastError?: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const ExtractionSchema = new Schema<IExtraction>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true, index: true },
    extractionType: { type: String, default: "OCR_TO_JSON" },
    provider: { type: String, default: "OLLAMA" },
    status: {
      type: String,
      enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "RETRYING"],
      default: "PENDING",
    },
    attempts: { type: Number, default: 0 },
    modelName: { type: String },
    rawResponse: { type: String },
    structuredData: { type: Schema.Types.Mixed, default: {} },
    inputTextHash: { type: String },
    retryAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "extractions" }
);

export const Extraction =
  mongoose.models.Extraction || mongoose.model<IExtraction>("Extraction", ExtractionSchema);
