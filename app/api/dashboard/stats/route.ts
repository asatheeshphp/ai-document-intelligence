import { NextResponse } from "next/server";
import { ProcessingRepository } from "@/repositories/processing.repository";

export async function GET() {
  try {
    const repository = new ProcessingRepository();
    const stats = await repository.getDashboardStats();

    return NextResponse.json({ success: true, stats });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown dashboard stats error",
      },
      { status: 500 }
    );
  }
}
