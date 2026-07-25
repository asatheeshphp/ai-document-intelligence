import { z } from "zod";

export const DocumentTypeLabels = [
  "INVOICE",
  "RECEIPT",
  "PURCHASE_ORDER",
  "CONTRACT",
  "RESUME",
  "OTHER",
] as const;

export const DocumentClassificationSchema = z.object({
  documentType: z.enum(DocumentTypeLabels),
  confidence: z.number().min(0).max(1),
});

export type DocumentClassification = z.infer<typeof DocumentClassificationSchema>;

export const DocumentClassificationJsonSchema = z.toJSONSchema(DocumentClassificationSchema, {
  target: "draft-2020-12",
});
