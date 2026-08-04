import { NextResponse } from "next/server";
import { DashboardAnalyticsService } from "@/services/dashboard-analytics.service";

export async function GET() {
  try {
    const service = new DashboardAnalyticsService();
    const data = await service.getBusinessDashboardData();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown dashboard business-data error",
      },
      { status: 500 }
    );
  }
}
