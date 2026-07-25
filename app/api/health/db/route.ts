import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDatabase } from "@/db/database";

export async function GET() {
  try {
    await connectDatabase();

    return NextResponse.json({
      success: true,
      database: "connected",
      host: mongoose.connection.host,
      databaseName: mongoose.connection.name,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown database error",
      },
      { status: 500 }
    );
  }
}