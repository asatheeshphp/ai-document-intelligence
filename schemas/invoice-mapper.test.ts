import { describe, it, expect } from "vitest";
import { mapInvoiceExtractionToInvoiceFields } from "@/schemas/invoice-mapper";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

function baseExtraction(invoiceDate: string | null): InvoiceExtraction {
  return {
    invoice: { invoiceNumber: "INV-1", invoiceDate, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
    supplier: { name: "Vendor", address: { raw: null, street: null, city: null, state: null, postalCode: null, country: null }, taxId: null, email: null, phone: null },
    customer: { name: "Customer", address: { raw: null, street: null, city: null, state: null, postalCode: null, country: null }, taxId: null, email: null, phone: null },
    shipping: { address: { raw: null, street: null, city: null, state: null, postalCode: null, country: null }, method: null, trackingNumber: null },
    lineItems: [],
    taxes: [],
    totals: { subtotal: null, totalTax: null, discount: null, shippingCharge: null, grandTotal: null, amountInWords: null },
    bankDetails: { bankName: null, accountName: null, accountNumber: null, ifscCode: null, swiftCode: null, branch: null },
    notes: null,
    references: [],
    additionalFields: {},
  } as unknown as InvoiceExtraction;
}

describe("mapInvoiceExtractionToInvoiceFields — date parsing", () => {
  it("parses day-first DD/MM/YYYY dates correctly, not as month-first", () => {
    // Confirmed live: native `new Date("19/03/2023")` returns Invalid Date and
    // previously silently dropped this real invoice's date entirely.
    const result = mapInvoiceExtractionToInvoiceFields(baseExtraction("19/03/2023"));

    expect(result.invoiceDate).toBeInstanceOf(Date);
    expect(result.invoiceDate?.getUTCFullYear()).toBe(2023);
    expect(result.invoiceDate?.getUTCMonth()).toBe(2); // March, zero-indexed
    expect(result.invoiceDate?.getUTCDate()).toBe(19);
  });

  it("resolves a genuinely ambiguous D/M/YYYY date (both <=12) as day-first", () => {
    const result = mapInvoiceExtractionToInvoiceFields(baseExtraction("03/04/2023"));

    expect(result.invoiceDate?.getUTCMonth()).toBe(3); // April, zero-indexed
    expect(result.invoiceDate?.getUTCDate()).toBe(3);
  });

  it("parses DD-MMM-YYYY dates (e.g. 21-Jul-2026)", () => {
    const result = mapInvoiceExtractionToInvoiceFields(baseExtraction("21-Jul-2026"));

    expect(result.invoiceDate?.getUTCFullYear()).toBe(2026);
    expect(result.invoiceDate?.getUTCMonth()).toBe(6); // July, zero-indexed
    expect(result.invoiceDate?.getUTCDate()).toBe(21);
  });

  it("parses ISO 8601 dates (YYYY-MM-DD)", () => {
    const result = mapInvoiceExtractionToInvoiceFields(baseExtraction("2026-07-21"));

    expect(result.invoiceDate?.getUTCFullYear()).toBe(2026);
    expect(result.invoiceDate?.getUTCMonth()).toBe(6);
    expect(result.invoiceDate?.getUTCDate()).toBe(21);
  });

  it("returns undefined for null or genuinely unparseable dates", () => {
    expect(mapInvoiceExtractionToInvoiceFields(baseExtraction(null)).invoiceDate).toBeUndefined();
    expect(mapInvoiceExtractionToInvoiceFields(baseExtraction("not a date")).invoiceDate).toBeUndefined();
  });
});
