import mongoose, { Schema, type Types } from "mongoose";

export type InvoiceStatus = "NEW" | "EXTRACTED" | "VALIDATED" | "FAILED";

export interface IInvoice extends mongoose.Document {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  poNumber?: string;
  currency?: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  status: InvoiceStatus;
  extractedData: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true, index: true },
    invoiceNumber: { type: String, index: true },
    vendorName: { type: String, index: true },
    customerName: { type: String, index: true },
    invoiceDate: { type: Date, index: true },
    dueDate: { type: Date },
    poNumber: { type: String },
    currency: { type: String },
    subtotal: { type: Number },
    taxAmount: { type: Number },
    totalAmount: { type: Number },
    status: {
      type: String,
      enum: ["NEW", "EXTRACTED", "VALIDATED", "FAILED"],
      default: "NEW",
    },
    extractedData: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: "invoices",
  }
);

export const Invoice =
  mongoose.models.Invoice || mongoose.model<IInvoice>("Invoice", InvoiceSchema);