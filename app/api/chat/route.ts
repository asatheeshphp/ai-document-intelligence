import { NextResponse } from "next/server";
import { RagService, type RagChatTurn } from "@/services/rag.service";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const question = body?.question as string | undefined;

    if (!question || !question.trim()) {
      return NextResponse.json({ success: false, error: "question is required" }, { status: 400 });
    }

    const history = Array.isArray(body?.history) ? (body.history as RagChatTurn[]) : undefined;

    const ragService = new RagService();
    const { answer, sources, mode } = await ragService.answer({ question, history });

    return NextResponse.json({ success: true, question, answer, sources, mode });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown chat error",
      },
      { status: 500 }
    );
  }
}
