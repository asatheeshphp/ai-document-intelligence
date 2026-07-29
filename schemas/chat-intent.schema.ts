import { z } from "zod";

// Dates are kept as plain "YYYY-MM-DD" strings here, not parsed to Date objects --
// parsing/validation happens where they're actually used (SpendQueryService), keeping
// this schema focused purely on "did the model's answer line parse into a shape."
export const ChatIntentSchema = z.object({
  type: z.enum(["AGGREGATION", "RETRIEVAL", "STATUS_FILTER"]),
  vendor: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // Only set for STATUS_FILTER -- mirrors the paymentStatus/dueDate filter shape
  // app/api/invoices/due/route.ts already queries with, so a chat question like "any
  // unpaid invoices?" resolves to the exact same data that page's UI already surfaces.
  status: z.enum(["PAID", "UNPAID", "OVERDUE"]).optional(),
});

export type ChatIntent = z.infer<typeof ChatIntentSchema>;
