import { NextResponse } from "next/server";
import { EmailIngestionService } from "@/services/email-ingestion.service";

export async function POST() {
  try {
    const service = new EmailIngestionService();
    const result = await service.checkInbox();

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown inbox-check error",
      },
      { status: 500 }
    );
  }
}
