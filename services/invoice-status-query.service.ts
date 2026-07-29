import { ProcessingRepository } from "@/repositories/processing.repository";
import type { IInvoice } from "@/models/invoice.model";

export type InvoiceStatusFilter = "PAID" | "UNPAID" | "OVERDUE";

export interface InvoiceStatusSummaryItem {
  invoiceNumber?: string;
  vendorName?: string;
  totalAmount?: number;
  currency?: string;
  dueDate?: Date;
}

export class InvoiceStatusQueryService {
  constructor(private readonly repository: ProcessingRepository = new ProcessingRepository()) {}

  async listByStatus(status: InvoiceStatusFilter): Promise<InvoiceStatusSummaryItem[]> {
    const invoices = await this.repository.listInvoices(this.buildFilter(status));
    return invoices.map((invoice) => this.toSummaryItem(invoice));
  }

  // Mirrors app/api/invoices/due/route.ts's existing filter exactly, so a chat question
  // like "any unpaid invoices?" resolves to the same data that page's UI already
  // surfaces, rather than a second, possibly-diverging definition of "unpaid."
  private buildFilter(status: InvoiceStatusFilter): Record<string, unknown> {
    switch (status) {
      case "PAID":
        return { paymentStatus: "PAID" };
      case "OVERDUE":
        return { paymentStatus: { $ne: "PAID" }, dueDate: { $ne: null, $lt: new Date() } };
      case "UNPAID":
      default:
        // Not PAID (rather than strictly PENDING) -- invoices created before this field
        // existed have no paymentStatus stored at all; $ne: "PAID" treats "field absent"
        // the same as "not yet paid," matching due/route.ts's own reasoning.
        return { paymentStatus: { $ne: "PAID" } };
    }
  }

  private toSummaryItem(invoice: IInvoice): InvoiceStatusSummaryItem {
    return {
      invoiceNumber: invoice.invoiceNumber,
      vendorName: invoice.vendorName,
      totalAmount: invoice.totalAmount,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
    };
  }
}
