import { describe, it, expect } from "vitest";
import { DocumentQualityService } from "@/services/document-quality.service";

describe("DocumentQualityService", () => {
  const service = new DocumentQualityService();

  it("scores empty text at the minimum", () => {
    const result = service.assess("", 1);
    expect(result.score).toBeLessThan(0.1);
  });

  it("scores dense symbol-only garbage low", () => {
    const garbled = "%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%";
    const result = service.assess(garbled, 1);
    expect(result.score).toBeLessThan(0.3);
  });

  it("scores clean, readable invoice-like text highly", () => {
    const clean = `Invoice Number INV dash one thousand one Date January fifteen twenty twenty six
Vendor ABC Technologies Private Limited Customer Example Corporation
Description Quantity Unit Price Amount Consulting Services ten hours
Total amount due fifteen hundred dollars Payment terms net thirty days
Thank you for your business We appreciate your prompt payment
Please remit payment to the address listed above
Contact accounts receivable for any questions regarding this invoice`;
    const result = service.assess(clean, 1);
    expect(result.score).toBeGreaterThan(0.6);
  });

  it("scores the same text lower per-page as page count increases", () => {
    const text = "Some readable words here and there in this document body";
    const onePage = service.assess(text, 1);
    const fivePages = service.assess(text, 5);
    expect(fivePages.signals.charsPerPage).toBeLessThan(onePage.signals.charsPerPage);
  });

  it("never divides by zero on empty tokens", () => {
    const result = service.assess("   ", 1);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
