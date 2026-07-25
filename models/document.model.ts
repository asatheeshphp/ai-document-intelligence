import mongoose, { Schema, type Types } from "mongoose";

export type DocumentStatus =
  | "PENDING"
  | "DOWNLOADED"
  | "EXTRACTING"
  | "EXTRACTED"
  | "OCR_REQUIRED"
  | "OCR_COMPLETE"
  | "FAILED";

export type DocumentType = "INVOICE" | "RECEIPT" | "UNKNOWN";

export interface IDocument extends mongoose.Document {
  _id: Types.ObjectId;
  emailId: Types.ObjectId;
  documentType: DocumentType;
  filename?: string;
  contentType?: string;
  fileSize?: number;
  storagePath?: string;
  checksum?: string;
  status: DocumentStatus;
  extractedText?: string;
  processingAttempts: number;
  retryAt?: Date | null;
  lastError?: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
  {
    emailId: { type: Schema.Types.ObjectId, ref: "Email", required: true, index: true },
    documentType: {
      type: String,
      enum: ["INVOICE", "RECEIPT", "UNKNOWN"],
      default: "UNKNOWN",
      index: true,
    },
    filename: { type: String },
    contentType: { type: String },
    fileSize: { type: Number },
    storagePath: { type: String },
    checksum: { type: String },
    status: {
      type: String,
      enum: ["PENDING", "DOWNLOADED", "EXTRACTING", "EXTRACTED", "OCR_REQUIRED", "OCR_COMPLETE", "FAILED"],
      default: "PENDING",
    },
    extractedText: { type: String },
    processingAttempts: { type: Number, default: 0 },
    retryAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "documents" }
);

export const Document =
  mongoose.models.Document || mongoose.model<IDocument>("Document", DocumentSchema);
