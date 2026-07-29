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
  status: z.enum(["PAID", "UNPAID", "OVERDUE"]).optional(),
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
