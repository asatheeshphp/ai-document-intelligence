import { describe, it, expect } from "vitest";
import { buildInvoiceChunks } from "@/schemas/invoice-chunker";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

const emptyAddress = { raw: null, street: null, city: null, state: null, postalCode: null, country: null };
const emptyParty = { name: null, address: emptyAddress, taxId: null, email: null, phone: null };

function baseExtraction(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
    supplier: emptyParty,
    customer: emptyParty,
    shipping: { address: emptyAddress, method: null, trackingNumber: null },
    lineItems: [],
    taxes: [],
    totals: { subtotal: null, totalTax: null, discount: null, shippingCharge: null, grandTotal: null, amountInWords: null },
    bankDetails: { bankName: null, accountName: null, accountNumber: null, ifscCode: null, swiftCode: null, branch: null },
    notes: null,
    references: [],
    additionalFields: {},
    ...overrides,
  };
}

describe("buildInvoiceChunks", () => {
  it("emits one chunk per line item instead of one combined block", () => {
    const extraction = baseExtraction({
      lineItems: [
        { description: "Widget A", quantity: 2, unit: "pcs", unitPrice: 10, taxRate: null, amount: 20 },
        { description: "Widget B", quantity: 1, unit: "pcs", unitPrice: 5, taxRate: null, amount: 5 },
        { description: "Widget C", quantity: 3, unit: "pcs", unitPrice: 7, taxRate: null, amount: 21 },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const lineItemChunks = chunks.filter((chunk) => chunk.type === "line_items");

    expect(lineItemChunks).toHaveLength(3);
    expect(lineItemChunks[0].text).toContain("Widget A");
    expect(lineItemChunks[1].text).toContain("Widget B");
    expect(lineItemChunks[2].text).toContain("Widget C");
    // Each chunk should be short — no chunk should contain another item's description.
    expect(lineItemChunks[0].text).not.toContain("Widget B");
  });

  it("emits one chunk per tax entry", () => {
    const extraction = baseExtraction({
      taxes: [
        { type: "CGST", rate: 9, amount: 18 },
        { type: "SGST", rate: 9, amount: 18 },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const taxChunks = chunks.filter((chunk) => chunk.type === "taxes");

    expect(taxChunks).toHaveLength(2);
    expect(taxChunks[0].text).toContain("CGST");
    expect(taxChunks[1].text).toContain("SGST");
    expect(taxChunks[0].text).not.toContain("SGST");
  });

  it("emits one chunk per reference, tagged as notes type", () => {
    const extraction = baseExtraction({
      references: [
        { type: "PO", value: "PO-123" },
        { type: "GRN", value: "GRN-456" },
      ],
    });

    const chunks = buildInvoiceChunks(extraction);
    const noteChunks = chunks.filter((chunk) => chunk.type === "notes");

    expect(noteChunks.some((chunk) => chunk.text.includes("PO-123"))).toBe(true);
    expect(noteChunks.some((chunk) => chunk.text.includes("GRN-456"))).toBe(true);
    // The two references should be in separate chunks, not combined into one.
    const poChunk = noteChunks.find((chunk) => chunk.text.includes("PO-123"));
    expect(poChunk?.text).not.toContain("GRN-456");
  });

  it("keeps header, supplier, customer, and payment as single combined chunks", () => {
    const extraction = baseExtraction({
      invoice: { invoiceNumber: "INV-1", invoiceDate: null, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
      supplier: { ...emptyParty, name: "Acme Corp", email: "billing@acme.com" },
      totals: { subtotal: 100, totalTax: 18, discount: null, shippingCharge: null, grandTotal: 118, amountInWords: null },
    });

    const chunks = buildInvoiceChunks(extraction);

    expect(chunks.filter((chunk) => chunk.type === "header")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "supplier")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "payment")).toHaveLength(1);
  });

  it("falls back to a single JSON chunk when there is no extractable data at all", () => {
    const chunks = buildInvoiceChunks(baseExtraction());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("other");
  });

  it("produces contiguous, non-overlapping offsets across all chunks", () => {
    const extraction = baseExtraction({
      lineItems: [{ description: "Widget A", quantity: 1, unit: null, unitPrice: 10, taxRate: null, amount: 10 }],
      taxes: [{ type: "VAT", rate: 20, amount: 2 }],
    });

    const chunks = buildInvoiceChunks(extraction);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end);
    }
  });
});
