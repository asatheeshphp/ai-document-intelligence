import { ProcessingRepository } from "@/repositories/processing.repository";
import type { IInvoice } from "@/models/invoice.model";

export type InvoiceStatusFilter = "PAID" | "UNPAID" | "OVERDUE" | "UPCOMING";

export interface InvoiceStatusSummaryItem {
  invoiceNumber?: string;
  vendorName?: string;
  totalAmount?: number;
  currency?: string;
  dueDate?: Date;
}

export interface InvoiceStatusLookupItem extends InvoiceStatusSummaryItem {
  paymentStatus: "PAID" | "PENDING";
  isOverdue: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class InvoiceStatusQueryService {
  constructor(private readonly repository: ProcessingRepository = new ProcessingRepository()) {}

  async listByStatus(
    status: InvoiceStatusFilter,
    dueWithinDays?: number,
    invoiceDateRange?: { from: Date; to: Date }
  ): Promise<InvoiceStatusSummaryItem[]> {
    const filter = this.buildFilter(status, dueWithinDays);
    if (invoiceDateRange) {
      filter.invoiceDate = { $gte: invoiceDateRange.from, $lte: invoiceDateRange.to };
    }
    const invoices = await this.repository.listInvoices(filter);
    return invoices.map((invoice) => this.toSummaryItem(invoice));
  }

  // Confirmed live: "what is the payment status of invoice EXL-2026-2048?" ran the
  // SAME blanket "list every PAID invoice" query as "any paid invoices?" -- the invoice
  // number was extracted but never used, silently discarded. This looks up that one
  // invoice directly and reports its REAL current status, deliberately ignoring
  // whatever `status` value the model guessed for the question -- the point of a
  // per-invoice question is to report what the status actually IS, not to test a guess
  // that might itself be wrong.
  async getStatusForInvoiceNumber(invoiceNumber: string): Promise<InvoiceStatusLookupItem[]> {
    const pattern = `^${escapeRegExp(invoiceNumber.trim())}$`;
    const invoices = await this.repository.listInvoices({ invoiceNumber: { $regex: pattern, $options: "i" } });
    const now = new Date();

    return invoices.map((invoice) => {
      const paymentStatus = invoice.paymentStatus === "PAID" ? "PAID" : "PENDING";
      return {
        ...this.toSummaryItem(invoice),
        paymentStatus,
        isOverdue: paymentStatus !== "PAID" && Boolean(invoice.dueDate) && invoice.dueDate! < now,
      };
    });
  }

  // Mirrors app/api/invoices/due/route.ts's existing filter exactly, so a chat question
  // like "any unpaid invoices?" resolves to the same data that page's UI already
  // surfaces, rather than a second, possibly-diverging definition of "unpaid."
  private buildFilter(status: InvoiceStatusFilter, dueWithinDays?: number): Record<string, unknown> {
    switch (status) {
      case "PAID":
        return { paymentStatus: "PAID" };
      case "OVERDUE":
        return { paymentStatus: { $ne: "PAID" }, dueDate: { $ne: null, $lt: new Date() } };
      case "UPCOMING": {
        // Bounded window (today..today+N days), unlike OVERDUE's open-ended "< now" --
        // "upcoming" means not-yet-due-but-due-soon, not "any unpaid invoice ever."
        // Falls back to 7 days if the question didn't name a number.
        const now = new Date();
        const horizon = new Date(now.getTime() + (dueWithinDays ?? 7) * 24 * 60 * 60 * 1000);
        return { paymentStatus: { $ne: "PAID" }, dueDate: { $ne: null, $gte: now, $lte: horizon } };
      }
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
