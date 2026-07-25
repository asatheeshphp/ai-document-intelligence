import type { InvoiceExtraction } from "@/schemas/invoice.schema";
import type { ChunkType } from "@/models/chunk.model";

export interface InvoiceChunkDraft {
  type: ChunkType;
  text: string;
  start: number;
  end: number;
  tokenCount: number;
}

type Address = InvoiceExtraction["supplier"]["address"];
type Party = InvoiceExtraction["supplier"];

function formatAddress(address: Address): string | null {
  if (address.raw) return address.raw;
  const parts = [address.street, address.city, address.state, address.postalCode, address.country].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatParty(label: string, party: Party): string | null {
  const lines: string[] = [];
  if (party.name) lines.push(`${label}: ${party.name}`);

  const address = formatAddress(party.address);
  if (address) lines.push(`Address: ${address}`);
  if (party.taxId) lines.push(`Tax ID: ${party.taxId}`);
  if (party.email) lines.push(`Email: ${party.email}`);
  if (party.phone) lines.push(`Phone: ${party.phone}`);

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatHeader(extraction: InvoiceExtraction): string | null {
  const { invoice } = extraction;
  const lines: string[] = [];
  if (invoice.invoiceNumber) lines.push(`Invoice Number: ${invoice.invoiceNumber}`);
  if (invoice.invoiceDate) lines.push(`Invoice Date: ${invoice.invoiceDate}`);
  if (invoice.dueDate) lines.push(`Due Date: ${invoice.dueDate}`);
  if (invoice.poNumber) lines.push(`PO Number: ${invoice.poNumber}`);
  if (invoice.currency) lines.push(`Currency: ${invoice.currency}`);
  if (invoice.paymentTerms) lines.push(`Payment Terms: ${invoice.paymentTerms}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

// Returns one string per line item (not one combined block) so each chunk stays short
// enough for SigLIP2's limited text-embedding input length.
function formatLineItems(items: InvoiceExtraction["lineItems"]): string[] {
  const meaningful = items.filter((item) => item.description || item.amount != null);

  return meaningful.map((item) => {
    const parts: string[] = [item.description ?? "Item"];
    if (item.quantity != null) parts.push(`qty ${item.quantity}${item.unit ? ` ${item.unit}` : ""}`);
    if (item.unitPrice != null) parts.push(`unit price ${item.unitPrice}`);
    if (item.taxRate != null) parts.push(`tax rate ${item.taxRate}%`);
    if (item.amount != null) parts.push(`amount ${item.amount}`);
    return parts.join(", ");
  });
}

// One string per tax entry, same reasoning as formatLineItems.
function formatTaxes(taxes: InvoiceExtraction["taxes"]): string[] {
  const meaningful = taxes.filter((tax) => tax.type || tax.rate != null || tax.amount != null);

  return meaningful.map((tax) => {
    const parts: string[] = [tax.type ?? "Tax"];
    if (tax.rate != null) parts.push(`rate ${tax.rate}%`);
    if (tax.amount != null) parts.push(`amount ${tax.amount}`);
    return parts.join(", ");
  });
}

// One string per reference, same reasoning as formatLineItems.
function formatReferences(references: InvoiceExtraction["references"]): string[] {
  const meaningful = references.filter((ref) => ref.type || ref.value);
  return meaningful.map((ref) => `${ref.type ?? "Reference"}: ${ref.value ?? "N/A"}`);
}

function formatPayment(extraction: InvoiceExtraction): string | null {
  const { totals, bankDetails } = extraction;
  const lines: string[] = [];

  if (totals.subtotal != null) lines.push(`Subtotal: ${totals.subtotal}`);
  if (totals.discount != null) lines.push(`Discount: ${totals.discount}`);
  if (totals.shippingCharge != null) lines.push(`Shipping Charge: ${totals.shippingCharge}`);
  if (totals.totalTax != null) lines.push(`Total Tax: ${totals.totalTax}`);
  if (totals.grandTotal != null) lines.push(`Grand Total: ${totals.grandTotal}`);
  if (totals.amountInWords) lines.push(`Amount In Words: ${totals.amountInWords}`);

  const bankLines: string[] = [];
  if (bankDetails.bankName) bankLines.push(`Bank Name: ${bankDetails.bankName}`);
  if (bankDetails.accountName) bankLines.push(`Account Name: ${bankDetails.accountName}`);
  if (bankDetails.accountNumber) bankLines.push(`Account Number: ${bankDetails.accountNumber}`);
  if (bankDetails.ifscCode) bankLines.push(`IFSC Code: ${bankDetails.ifscCode}`);
  if (bankDetails.swiftCode) bankLines.push(`SWIFT Code: ${bankDetails.swiftCode}`);
  if (bankDetails.branch) bankLines.push(`Branch: ${bankDetails.branch}`);

  if (bankLines.length > 0) {
    lines.push("Bank Details:", ...bankLines);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

// Notes text + shipping info only — these are bounded, fixed-field data, unlike
// references (an open-ended array), which gets its own per-item chunks instead.
function formatNotesAndShipping(extraction: InvoiceExtraction): string | null {
  const { notes, shipping } = extraction;
  const lines: string[] = [];

  if (notes) lines.push(notes);

  const shippingAddress = formatAddress(shipping.address);
  if (shippingAddress || shipping.method || shipping.trackingNumber) {
    lines.push("Shipping:");
    if (shippingAddress) lines.push(`Address: ${shippingAddress}`);
    if (shipping.method) lines.push(`Method: ${shipping.method}`);
    if (shipping.trackingNumber) lines.push(`Tracking Number: ${shipping.trackingNumber}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function buildInvoiceChunks(extraction: InvoiceExtraction): InvoiceChunkDraft[] {
  const chunks: InvoiceChunkDraft[] = [];
  let offset = 0;

  const pushChunk = (type: ChunkType, text: string) => {
    const start = offset;
    const end = start + text.length;
    chunks.push({
      type,
      text,
      start,
      end,
      tokenCount: text.split(/\s+/).filter(Boolean).length,
    });
    offset = end + 1;
  };

  const singleTextSections: Array<{ type: ChunkType; text: string | null }> = [
    { type: "header", text: formatHeader(extraction) },
    { type: "supplier", text: formatParty("Supplier", extraction.supplier) },
    { type: "customer", text: formatParty("Customer", extraction.customer) },
  ];

  for (const section of singleTextSections) {
    if (section.text) pushChunk(section.type, section.text);
  }

  for (const text of formatLineItems(extraction.lineItems)) {
    pushChunk("line_items", text);
  }

  for (const text of formatTaxes(extraction.taxes)) {
    pushChunk("taxes", text);
  }

  const payment = formatPayment(extraction);
  if (payment) pushChunk("payment", payment);

  const notesAndShipping = formatNotesAndShipping(extraction);
  if (notesAndShipping) pushChunk("notes", notesAndShipping);

  for (const text of formatReferences(extraction.references)) {
    pushChunk("notes", text);
  }

  if (chunks.length === 0) {
    const fallbackText = JSON.stringify(extraction);
    pushChunk("other", fallbackText);
  }

  return chunks;
}
