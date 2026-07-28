import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.string().default("3000"),
  MONGODB_URI: z.string(),
  OLLAMA_BASE_URL: z.string(),
  OLLAMA_CHAT_MODEL: z.string(),
  OLLAMA_EMBED_MODEL: z.string(),
  OLLAMA_VISION_MODEL: z.string().default("qwen2.5vl:7b"),
  DOCUMENT_QUALITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  E5_SERVICE_URL: z.string().default("http://127.0.0.1:8001"),
});

export const env = schema.parse(process.env);