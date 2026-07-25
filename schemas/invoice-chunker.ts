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

function formatLineItems(items: InvoiceExtraction["lineItems"]): string | null {
  const meaningful = items.filter((item) => item.description || item.amount != null);
  if (meaningful.length === 0) return null;

  const lines = meaningful.map((item) => {
    const parts: string[] = [item.description ?? "Item"];
    if (item.quantity != null) parts.push(`qty ${item.quantity}${item.unit ? ` ${item.unit}` : ""}`);
    if (item.unitPrice != null) parts.push(`unit price ${item.unitPrice}`);
    if (item.taxRate != null) parts.push(`tax rate ${item.taxRate}%`);
    if (item.amount != null) parts.push(`amount ${item.amount}`);
    return `- ${parts.join(", ")}`;
  });

  return `Line Items:\n${lines.join("\n")}`;
}

function formatTaxes(taxes: InvoiceExtraction["taxes"]): string | null {
  const meaningful = taxes.filter((tax) => tax.type || tax.rate != null || tax.amount != null);
  if (meaningful.length === 0) return null;

  const lines = meaningful.map((tax) => {
    const parts: string[] = [tax.type ?? "Tax"];
    if (tax.rate != null) parts.push(`rate ${tax.rate}%`);
    if (tax.amount != null) parts.push(`amount ${tax.amount}`);
    return `- ${parts.join(", ")}`;
  });

  return `Taxes:\n${lines.join("\n")}`;
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

function formatNotes(extraction: InvoiceExtraction): string | null {
  const { notes, references, shipping } = extraction;
  const lines: string[] = [];

  if (notes) lines.push(notes);

  const meaningfulRefs = references.filter((ref) => ref.type || ref.value);
  if (meaningfulRefs.length > 0) {
    lines.push("References:");
    for (const ref of meaningfulRefs) {
      lines.push(`- ${ref.type ?? "Reference"}: ${ref.value ?? "N/A"}`);
    }
  }

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
  const sections: Array<{ type: ChunkType; text: string | null }> = [
    { type: "header", text: formatHeader(extraction) },
    { type: "supplier", text: formatParty("Supplier", extraction.supplier) },
    { type: "customer", text: formatParty("Customer", extraction.customer) },
    { type: "line_items", text: formatLineItems(extraction.lineItems) },
    { type: "taxes", text: formatTaxes(extraction.taxes) },
    { type: "payment", text: formatPayment(extraction) },
    { type: "notes", text: formatNotes(extraction) },
  ];

  const chunks: InvoiceChunkDraft[] = [];
  let offset = 0;

  for (const section of sections) {
    if (!section.text) continue;

    const start = offset;
    const end = start + section.text.length;
    chunks.push({
      type: section.type,
      text: section.text,
      start,
      end,
      tokenCount: section.text.split(/\s+/).filter(Boolean).length,
    });
    offset = end + 1;
  }

  if (chunks.length === 0) {
    const fallbackText = JSON.stringify(extraction);
    chunks.push({
      type: "other",
      text: fallbackText,
      start: 0,
      end: fallbackText.length,
      tokenCount: fallbackText.split(/\s+/).filter(Boolean).length,
    });
  }

  return chunks;
}
