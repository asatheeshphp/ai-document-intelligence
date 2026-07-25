import { NextResponse } from "next/server";
import { SearchService, type SearchFilters } from "@/services/search.service";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = body?.query as string | undefined;

    if (!query) {
      return NextResponse.json({ success: false, error: "query is required" }, { status: 400 });
    }

    const topK = typeof body?.topK === "number" ? body.topK : undefined;
    const threshold = typeof body?.threshold === "number" ? body.threshold : undefined;
    const filters = (body?.filters as SearchFilters | undefined) ?? undefined;

    const searchService = new SearchService();
    const { results, queryVectorDimension } = await searchService.search({
      query,
      topK,
      threshold,
      filters,
    });

    return NextResponse.json({
      success: true,
      query,
      queryVectorDimension,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown search error",
      },
      { status: 500 }
    );
  }
}
