import { ProcessingRepository } from "@/repositories/processing.repository";

export interface VendorSpendSummary {
  vendorNames: string[];
  invoiceCount: number;
  totalAmount: number;
  currencies: string[];
}

export interface VendorSpendQueryInput {
  vendorNamePattern: string;
  // Plain "YYYY-MM-DD" strings, as extracted by OllamaService.detectChatIntent --
  // parsed to Date here, not upstream, keeping date-shape assumptions in one place.
  dateFrom?: string;
  dateTo?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Confirmed live: the model extracting the vendor name from a question sometimes drops
// spaces from a multi-word name (e.g. "Express Cargo" -> "ExpressCargo"), even with an
// explicit prompt instruction not to (see buildChatIntentPrompt) -- a literal regex
// match then fails against the real, space-containing stored vendorName, silently
// falling through to retrieval for a vendor that genuinely has invoices. Stripping
// whitespace from the extracted text and re-joining each character with an optional
// "\s*" produces a pattern that matches regardless of where (or whether) the model
// preserved spacing, without needing to guess real word boundaries.
function buildWhitespaceTolerantPattern(value: string): string {
  return value
    .replace(/\s+/g, "")
    .split("")
    .map(escapeRegExp)
    .join("\\s*");
}

export class SpendQueryService {
  constructor(private readonly repository: ProcessingRepository = new ProcessingRepository()) {}

  async getVendorSpendSummary(input: VendorSpendQueryInput): Promise<VendorSpendSummary | null> {
    const dateFrom = input.dateFrom ? new Date(`${input.dateFrom}T00:00:00.000Z`) : undefined;
    // Inclusive of the whole end day, not just midnight -- "spend through December 2026"
    // should include invoices dated anywhere on the 31st, not just at 00:00:00.
    const dateTo = input.dateTo ? new Date(`${input.dateTo}T23:59:59.999Z`) : undefined;

    return this.repository.getVendorSpendSummary({
      vendorNamePattern: buildWhitespaceTolerantPattern(input.vendorNamePattern),
      dateFrom,
      dateTo,
    });
  }
}
