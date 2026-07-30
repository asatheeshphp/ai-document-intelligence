import { z } from "zod";

// Dates are kept as plain "YYYY-MM-DD" strings here, not parsed to Date objects --
// parsing/validation happens where they're actually used (SpendQueryService), keeping
// this schema focused purely on "did the model's answer line parse into a shape."
export const ChatIntentSchema = z.object({
  type: z.enum(["AGGREGATION", "RETRIEVAL", "STATUS_FILTER", "LINE_ITEM_AGGREGATION"]),
  vendor: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // Only set for STATUS_FILTER -- mirrors the paymentStatus/dueDate filter shape
  // app/api/invoices/due/route.ts already queries with, so a chat question like "any
  // unpaid invoices?" resolves to the exact same data that page's UI already surfaces.
  status: z.enum(["PAID", "UNPAID", "OVERDUE", "UPCOMING"]).optional(),
  // Only set when status=UPCOMING -- the "N" in "due within/next N days". Mirrors the
  // OVERDUE filter's dueDate comparison but bounded on both ends (today..today+N) instead
  // of open-ended in the past.
  dueWithinDays: z.coerce.number().int().positive().optional(),
  // Only set for STATUS_FILTER when the question names one specific invoice by number
  // (e.g. "what is the payment status of EXL-2026-2048?"). Confirmed live: without
  // this, "status of invoice X" questions ran the SAME blanket "list every PAID
  // invoice" query as "any paid invoices?" -- discarding the invoice number entirely
  // and answering about the wrong thing. When set, RagService looks up that invoice's
  // REAL current status directly, ignoring `status` above (the model's guessed status
  // is irrelevant once a specific invoice is named -- the point is to report what its
  // status actually is, not test a guess).
  invoiceNumber: z.string().optional(),
  // Only set for LINE_ITEM_AGGREGATION -- a product/category term (e.g. "computer",
  // "logistics services"), NOT a vendor name. Confirmed live: asking the model to
  // freely summarize/sum a category total led it to invent or mis-arithmetic a number
  // ("$1,330.29 * 3 = $4,000.87") from a garbled line-item fragment. This routes that
  // class of question to a real sum over each matching line item's own extracted
  // "amount" field instead, the same "never let the model touch the arithmetic"
  // principle AGGREGATION already established for vendor totals.
  keyword: z.string().optional(),
});

export type ChatIntent = z.infer<typeof ChatIntentSchema>;
