import { z } from "zod";

// Dates are kept as plain "YYYY-MM-DD" strings here, not parsed to Date objects --
// parsing/validation happens where they're actually used (SpendQueryService), keeping
// this schema focused purely on "did the model's answer line parse into a shape."
export const ChatIntentSchema = z.object({
  type: z.enum(["AGGREGATION", "RETRIEVAL"]),
  vendor: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type ChatIntent = z.infer<typeof ChatIntentSchema>;
