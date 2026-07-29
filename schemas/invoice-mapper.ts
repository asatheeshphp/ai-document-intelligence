import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import utc from "dayjs/plugin/utc";
import type { InvoiceExtraction } from "@/schemas/invoice.schema";

dayjs.extend(customParseFormat);
dayjs.extend(utc);

// Explicit formats, tried in order, before falling back to native Date parsing. Native
// `new Date(value)` only reliably handles ISO 8601 and MM/DD/YYYY (US convention) --
// confirmed live: it silently returns Invalid Date for "19/03/2023" (day-first,
// DD/MM/YYYY), the actual format of a real invoice in this dataset, causing invoiceDate
// to be silently dropped entirely (not just wrong -- absent). Day-first formats are
// listed before month-first ones so a genuinely ambiguous date (both day and month <=12,
// e.g. "03/04/2023") resolves as day-first, matching the convention used throughout this
// invoice dataset, rather than however native Date happens to guess.
const KNOWN_DATE_FORMATS = [
  "DD/MM/YYYY",
  "DD-MM-YYYY",
  "D/M/YYYY",
  "D-M-YYYY",
  "DD-MMM-YYYY",
  "D-MMM-YYYY",
  "YYYY-MM-DD",
  "MM/DD/YYYY",
];

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

  for (const format of KNOWN_DATE_FORMATS) {
    // Parsed as UTC (dayjs.utc, not plain dayjs) so the stored instant is midnight UTC
    // on the intended calendar day, matching the Date.UTC(...) convention used
    // elsewhere in this app (e.g. utils/date-range-from-query.ts) -- plain local-time
    // parsing on this machine (UTC+5:30) would otherwise store the previous day's date
    // once read back via UTC getters.
    const parsed = dayjs.utc(value, format, true);
    if (parsed.isValid()) return parsed.toDate();
  }

  // Fallback for anything not covered above (ISO datetime strings, spelled-out months
  // like "March 4, 2023", etc.) that native Date parsing does handle correctly.
  const native = new Date(value);
  return Number.isNaN(native.getTime()) ? undefined : native;
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
