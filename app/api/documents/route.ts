import { NextResponse, type NextRequest } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { normalizeCurrency } from "@/utils/currency-normalize";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const page = Number(searchParams.get("page") ?? "1");
    const limit = Number(searchParams.get("limit") ?? "20");
    const vendorName = searchParams.get("vendorName") ?? undefined;
    const status = searchParams.get("status") ?? undefined;

    const repository = new ProcessingRepository();
    const result = await repository.listDocumentsWithSummary({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      vendorName,
      status,
    });

    return NextResponse.json({
      success: true,
      ...result,
      items: result.items.map((item) => ({ ...item, currency: normalizeCurrency(item.currency) ?? undefined })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown documents list error",
      },
      { status: 500 }
    );
  }
}
