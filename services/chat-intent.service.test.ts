import { describe, it, expect, vi } from "vitest";
import { ChatIntentService } from "@/services/chat-intent.service";
import type { OllamaService } from "@/services/ollama.service";

function fakeOllamaServiceWithSequence(
  outcomes: Array<{ success: boolean; data: Record<string, unknown> | null }>
): OllamaService {
  const detectChatIntent = vi.fn();
  for (const outcome of outcomes) {
    detectChatIntent.mockResolvedValueOnce({ raw: "", ...outcome });
  }
  return { detectChatIntent } as unknown as OllamaService;
}

function fakeOllamaService(outcome: { success: boolean; data: Record<string, unknown> | null }): OllamaService {
  return {
    detectChatIntent: vi.fn().mockResolvedValue({ raw: "", ...outcome }),
  } as unknown as OllamaService;
}

describe("ChatIntentService.detectIntent", () => {
  it("returns the model's intent when every attempt agrees", async () => {
    const ollama = fakeOllamaService({ success: true, data: { type: "AGGREGATION", vendor: "Readylink" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("How much have I paid Readylink?");

    expect(result).toEqual({ type: "AGGREGATION", vendor: "Readylink" });
    expect(ollama.detectChatIntent).toHaveBeenCalledTimes(3);
  });

  it("falls back to RETRIEVAL when every attempt fails to parse", async () => {
    const ollama = fakeOllamaService({ success: false, data: null });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("some garbled question");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("takes the majority vote when attempts disagree (2 AGGREGATION vs 1 RETRIEVAL)", async () => {
    // Mirrors the confirmed live failure mode: "How much have I paid Express Cargo?"
    // was classified RETRIEVAL on one attempt despite being phrased identically to a
    // question that correctly classified as AGGREGATION on other attempts.
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { type: "AGGREGATION", vendor: "Express Cargo" } },
      { success: true, data: { type: "RETRIEVAL" } },
      { success: true, data: { type: "AGGREGATION", vendor: "Express Cargo" } },
    ]);
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("How much have I paid Express Cargo?");

    expect(result).toEqual({ type: "AGGREGATION", vendor: "Express Cargo" });
  });

  it("takes the majority vote the other way (1 AGGREGATION vs 2 RETRIEVAL)", async () => {
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { type: "AGGREGATION", vendor: "Readylink" } },
      { success: true, data: { type: "RETRIEVAL" } },
      { success: true, data: { type: "RETRIEVAL" } },
    ]);
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("What did the Readylink invoice say?");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("takes the majority vote for STATUS_FILTER (2 STATUS_FILTER vs 1 RETRIEVAL)", async () => {
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { type: "STATUS_FILTER", status: "UNPAID" } },
      { success: true, data: { type: "RETRIEVAL" } },
      { success: true, data: { type: "STATUS_FILTER", status: "UNPAID" } },
    ]);
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("Any unpaid invoices?");

    expect(result).toEqual({ type: "STATUS_FILTER", status: "UNPAID" });
  });

  it("falls back to RETRIEVAL on a true 3-way tie (1 AGGREGATION vs 1 RETRIEVAL vs 1 STATUS_FILTER)", async () => {
    // With 3 categories now possible, a 3-vote split can be a genuine tie -- unlike the
    // old 2-category version where 3 votes always had a clear winner. An uncertain
    // result should fall through to the safe retrieval path rather than gambling on
    // either computed-answer category.
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { type: "AGGREGATION", vendor: "SuperStore" } },
      { success: true, data: { type: "RETRIEVAL" } },
      { success: true, data: { type: "STATUS_FILTER", status: "UNPAID" } },
    ]);
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("some ambiguous question");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("overrides a RETRIEVAL vote to STATUS_FILTER PAID for a 'paid invoices' listing question", async () => {
    // Confirmed live, deterministically (5/5 identical calls): the model reliably
    // misreads positive "paid" phrasing ("get the paid invoices") as RETRIEVAL, while
    // identically-shaped "unpaid" questions classify correctly every time -- a small-
    // model capacity limit that adding more prompt examples measurably made worse, not
    // better. The keyword override is the reliable fix.
    const ollama = fakeOllamaService({ success: true, data: { type: "RETRIEVAL" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("get the paid invoices");

    expect(result).toEqual({ type: "STATUS_FILTER", status: "PAID" });
  });

  it("does not override a genuine RETRIEVAL vote that only coincidentally mentions 'paid'", async () => {
    // Guards against the override being too broad: a real retrieval question that
    // happens to mention "paid" and "invoice" without being shaped as a listing request
    // must not be swept into STATUS_FILTER.
    const ollama = fakeOllamaService({ success: true, data: { type: "RETRIEVAL" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("Summarize the invoice from ABC that I already paid last month");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("does not apply the paid-status override when the model's vote was already AGGREGATION", async () => {
    const ollama = fakeOllamaService({ success: true, data: { type: "AGGREGATION", vendor: "Readylink" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("How much have I paid Readylink?");

    expect(result).toEqual({ type: "AGGREGATION", vendor: "Readylink" });
  });

  it("overrides a STATUS_FILTER vote back to RETRIEVAL for a 'payment condition(s)' question", async () => {
    // Confirmed live, deterministically (3/3 identical calls): the model reads
    // "condition(s)" as if it meant "status", misclassifying a payment-terms question
    // as a paid/unpaid filter. "payment terms?", "payment due date?", and "payment
    // method?" all correctly stayed RETRIEVAL on the same live model -- the boundary is
    // specifically the word "condition(s)".
    const ollama = fakeOllamaService({ success: true, data: { type: "STATUS_FILTER", status: "PAID" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("What is the payment condition?");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("overrides a STATUS_FILTER vote back to RETRIEVAL for 'payment conditions' naming a vendor", async () => {
    const ollama = fakeOllamaService({ success: true, data: { type: "STATUS_FILTER", status: "UNPAID" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("What are the payment conditions for Express Cargo?");

    expect(result).toEqual({ type: "RETRIEVAL" });
  });

  it("does not apply the payment-condition override to a genuine STATUS_FILTER vote with no 'condition' wording", async () => {
    const ollama = fakeOllamaService({ success: true, data: { type: "STATUS_FILTER", status: "UNPAID" } });
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("any unpaid invoices?");

    expect(result).toEqual({ type: "STATUS_FILTER", status: "UNPAID" });
  });

  it("counts a failed individual attempt as a RETRIEVAL vote rather than aborting", async () => {
    const ollama = fakeOllamaServiceWithSequence([
      { success: true, data: { type: "AGGREGATION", vendor: "SuperStore" } },
      { success: false, data: null },
      { success: true, data: { type: "AGGREGATION", vendor: "SuperStore" } },
    ]);
    const service = new ChatIntentService(ollama);

    const result = await service.detectIntent("What's my total spend with SuperStore?");

    expect(result).toEqual({ type: "AGGREGATION", vendor: "SuperStore" });
  });
});
