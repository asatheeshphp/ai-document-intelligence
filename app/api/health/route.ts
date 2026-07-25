import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    success: true,
    message: "AI Document Intelligence Platform is running",
    timestamp: new Date().toISOString(),
  });
}