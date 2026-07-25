import { describe, it, expect } from "vitest";
import {
  DocumentClassificationSchema,
  DocumentTypeLabels,
} from "@/schemas/document-classification.schema";

describe("DocumentClassificationSchema", () => {
  it("accepts a valid classification", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "INVOICE",
      confidence: 0.92,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a documentType outside the known label set", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "SPREADSHEET",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0-1", () => {
    const result = DocumentClassificationSchema.safeParse({
      documentType: "INVOICE",
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("exposes INVOICE and OTHER in the label set", () => {
    expect(DocumentTypeLabels).toContain("INVOICE");
    expect(DocumentTypeLabels).toContain("OTHER");
  });
});
