import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.string().default("3000"),
  MONGODB_URI: z.string(),
  OLLAMA_BASE_URL: z.string(),
  OLLAMA_CHAT_MODEL: z.string(),
  OLLAMA_EMBED_MODEL: z.string(),
});

export const env = schema.parse(process.env);