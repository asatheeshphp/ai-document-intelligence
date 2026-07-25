import mongoose, { Schema, type Types } from "mongoose";

export type EmailStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED"
  | "SKIPPED";

export interface IEmail extends mongoose.Document {
  _id: Types.ObjectId;
  messageId: string;
  senderAddress: string;
  senderName?: string;
  subject?: string;
  receivedAt: Date;
  source: "INBOX" | "MANUAL";
  status: EmailStatus;
  processingAttempts: number;
  retryAt?: Date | null;
  lastError?: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const EmailSchema = new Schema<IEmail>(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    senderAddress: { type: String, required: true, index: true },
    senderName: { type: String },
    subject: { type: String },
    receivedAt: { type: Date, default: Date.now, index: true },
    source: { type: String, enum: ["INBOX", "MANUAL"], default: "INBOX" },
    status: {
      type: String,
      enum: ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED", "SKIPPED"],
      default: "RECEIVED",
    },
    processingAttempts: { type: Number, default: 0 },
    retryAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "emails" }
);

export const Email =
  mongoose.models.Email || mongoose.model<IEmail>("Email", EmailSchema);
