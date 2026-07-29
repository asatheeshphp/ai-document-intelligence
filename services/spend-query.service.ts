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

export class SpendQueryService {
  constructor(private readonly repository: ProcessingRepository = new ProcessingRepository()) {}

  async getVendorSpendSummary(input: VendorSpendQueryInput): Promise<VendorSpendSummary | null> {
    const dateFrom = input.dateFrom ? new Date(`${input.dateFrom}T00:00:00.000Z`) : undefined;
    // Inclusive of the whole end day, not just midnight -- "spend through December 2026"
    // should include invoices dated anywhere on the 31st, not just at 00:00:00.
    const dateTo = input.dateTo ? new Date(`${input.dateTo}T23:59:59.999Z`) : undefined;

    return this.repository.getVendorSpendSummary({
      vendorNamePattern: input.vendorNamePattern,
      dateFrom,
      dateTo,
    });
  }
}
