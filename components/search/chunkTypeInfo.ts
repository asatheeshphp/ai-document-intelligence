// Mirrors what schemas/invoice-chunker.ts actually puts in each chunk type — keep these
// two in sync if the chunker's sections change. "footer" isn't listed here even though
// SearchResultCard has a fallback for it: buildInvoiceChunks never emits it today, so
// including it in the legend would describe something a user will never actually see.
export const CHUNK_TYPE_INFO: Record<string, { label: string; description: string }> = {
  header: { label: "Header", description: "Invoice number, dates, PO number, currency, payment terms" },
  supplier: { label: "Supplier", description: "Seller's name, address, tax ID, and contact details" },
  customer: { label: "Customer", description: "Buyer's name, address, tax ID, and contact details" },
  line_items: { label: "Line Items", description: "One entry per product or service billed" },
  taxes: { label: "Taxes", description: "One entry per tax or levy line (GST, VAT, etc.)" },
  payment: { label: "Payment", description: "Subtotal, discounts, shipping charge, grand total, bank details" },
  notes: { label: "Notes", description: "Remarks, shipping details, and reference numbers (PO, GRN, etc.)" },
  other: { label: "Other", description: "Fallback for a document with nothing else extractable" },
};
