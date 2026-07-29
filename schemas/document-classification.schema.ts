import { z } from "zod";

// Simplified from a 6-way classification (INVOICE/RECEIPT/PURCHASE_ORDER/CONTRACT/
// RESUME/OTHER) to a binary decision, per explicit instruction -- this app only ever
// acts on "is this an invoice or not," so the other 5 categories only gave the model
// more ways to get confused without changing any downstream behavior. See
// models/document.model.ts for why the old labels are still accepted in storage.
export const DocumentTypeLabels = ["INVOICE", "NOT_INVOICE"] as const;

export const DocumentClassificationSchema = z.object({
  documentType: z.enum(DocumentTypeLabels),
  confidence: z.number().min(0).max(1),
});

export type DocumentClassification = z.infer<typeof DocumentClassificationSchema>;
