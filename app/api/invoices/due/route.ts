import { NextResponse, type NextRequest } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";

const DEFAULT_WINDOW_DAYS = 7;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const windowDays = Number(searchParams.get("window") ?? DEFAULT_WINDOW_DAYS);
    const effectiveWindowDays = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : DEFAULT_WINDOW_DAYS;

    const repository = new ProcessingRepository();

    // Not PAID (rather than strictly "PENDING") -- invoices created before this field
    // existed have no paymentStatus stored at all, and { paymentStatus: "PENDING" }
    // would silently exclude them (Mongoose defaults only apply to newly-created
    // documents, never retroactively to already-stored rows). $ne: "PAID" correctly
    // treats "field absent" the same as "not yet paid," which is what it means anyway.
    const invoices = await repository.listInvoices({
      paymentStatus: { $ne: "PAID" },
      dueDate: { $ne: null },
    });

    const now = new Date();
    const soonThreshold = new Date(now.getTime() + effectiveWindowDays * 24 * 60 * 60 * 1000);

    const overdue = [];
    const dueSoon = [];

    for (const invoice of invoices) {
      const dueDate = invoice.dueDate;
      if (!dueDate) continue;

      const item = {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        vendorName: invoice.vendorName,
        dueDate,
        totalAmount: invoice.totalAmount,
        currency: invoice.currency,
      };

      if (dueDate < now) {
        overdue.push(item);
      } else if (dueDate <= soonThreshold) {
        dueSoon.push(item);
      }
    }

    overdue.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    dueSoon.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    return NextResponse.json({
      success: true,
      windowDays: effectiveWindowDays,
      overdue,
      dueSoon,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown due-invoices error",
      },
      { status: 500 }
    );
  }
}
