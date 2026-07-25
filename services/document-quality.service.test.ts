import { describe, it, expect } from "vitest";
import { DocumentQualityService } from "@/services/document-quality.service";

describe("DocumentQualityService", () => {
  const service = new DocumentQualityService();

  it("scores empty text at the minimum", () => {
    const result = service.assess("", 1);
    expect(result.score).toBeLessThan(0.1);
  });

  it("scores a page-length block of symbol-only garbage low", () => {
    const garbled = "%#@!&*^%$#@!&*^%$#@!&*^%$#@!&*^%$#@!&*^%$#@!&*^%$#@!&*^%$".repeat(9);
    expect(garbled.length).toBeGreaterThan(500);
    const result = service.assess(garbled, 1);
    expect(result.score).toBeLessThan(0.45);
  });

  it("scores clean, readable invoice-like text highly", () => {
    const clean = `Invoice Number: INV-1001                    Date: 01/15/2026
Vendor: ABC Technologies Pvt. Ltd.          Customer: Example Corp.

Description                Qty   Unit Price   Amount
Consulting Services        10    $150.00      $1,500.00
Software License Fee        1    $299.99      $299.99
Support & Maintenance       3    $50.00        $150.00

Subtotal:                                     $1,949.99
Tax (8.5%):                                   $165.75
Total Amount Due:                             $2,115.74

Payment Terms: Net 30 days
Please remit payment to the address listed above.
Contact accounts.receivable@abctech.com for any questions regarding this invoice.
Thank you for your business!`;
    const result = service.assess(clean, 1);
    expect(result.score).toBeGreaterThan(0.6);
  });

  it("does not saturate whitespace irregularity from ordinary column alignment", () => {
    const tableRow = "Description                Qty   Unit Price   Amount";
    const result = service.assess(tableRow, 1);
    expect(result.signals.whitespaceIrregularity).toBeLessThan(1);
  });

  it("treats digit-containing tokens like currency, dates, and reference numbers as recognizable", () => {
    const result = service.assess("INV-1001 $1,500.00 01/15/2026 10 30", 1);
    expect(result.signals.recognizableWordRatio).toBe(1);
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
