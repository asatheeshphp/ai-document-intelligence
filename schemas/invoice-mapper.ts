import type { InvoiceExtraction } from "@/schemas/invoice.schema";

export interface MappedInvoiceFields {
  invoiceNumber?: string;
  vendorName?: string;
  customerName?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  poNumber?: string;
  currency?: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  extractedData: Record<string, unknown>;
}

function toDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function mapInvoiceExtractionToInvoiceFields(
  extraction: InvoiceExtraction
): MappedInvoiceFields {
  return {
    invoiceNumber: extraction.invoice.invoiceNumber ?? undefined,
    vendorName: extraction.supplier.name ?? undefined,
    customerName: extraction.customer.name ?? undefined,
    invoiceDate: toDate(extraction.invoice.invoiceDate),
    dueDate: toDate(extraction.invoice.dueDate),
    poNumber: extraction.invoice.poNumber ?? undefined,
    currency: extraction.invoice.currency ?? undefined,
    subtotal: extraction.totals.subtotal ?? undefined,
    taxAmount: extraction.totals.totalTax ?? undefined,
    totalAmount: extraction.totals.grandTotal ?? undefined,
    extractedData: extraction as unknown as Record<string, unknown>,
  };
}
