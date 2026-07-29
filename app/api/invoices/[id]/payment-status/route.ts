import { NextResponse, type NextRequest } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const VALID_STATUSES = ["PENDING", "PAID"];

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const paymentStatus = body?.paymentStatus;

    if (!VALID_STATUSES.includes(paymentStatus)) {
      return NextResponse.json(
        { success: false, error: `paymentStatus must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 }
      );
    }

    const repository = new ProcessingRepository();
    const invoice = await repository.updateInvoicePaymentStatus(id, paymentStatus);

    if (!invoice) {
      return NextResponse.json({ success: false, error: "Invoice not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      invoiceId: invoice._id.toString(),
      paymentStatus: invoice.paymentStatus,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown payment-status update error",
      },
      { status: 500 }
    );
  }
}
