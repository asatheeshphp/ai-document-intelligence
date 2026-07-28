import { z } from "zod";

const REQUIRED_KEYS = ["EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASSWORD"] as const;

const schema = z.object({
  EMAIL_IMAP_HOST: z.string(),
  EMAIL_IMAP_PORT: z.coerce.number().default(993),
  EMAIL_IMAP_USER: z.string(),
  EMAIL_IMAP_PASSWORD: z.string(),
  EMAIL_IMAP_MAILBOX: z.string().default("INBOX"),
  EMAIL_ATTACHMENT_DIR: z.string().default("data/incoming"),
});

export type EmailEnv = z.infer<typeof schema>;

// Deliberately not part of config/env.ts's top-level `schema.parse(process.env)`, which
// runs at import time -- a developer not using the email feature yet shouldn't be blocked
// from running the rest of the app just because they haven't configured a mailbox. This
// validates lazily, only when the email feature is actually used, and names exactly which
// variable is missing rather than surfacing a generic zod error.
export function getEmailEnv(): EmailEnv {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Email inbox checking is not configured: missing ${missing.join(", ")}. ` +
        `Set these in .env.local -- see .env.local.example for the full list and how to ` +
        `generate an M365 app password.`
    );
  }

  return schema.parse(process.env);
}
