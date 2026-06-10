import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4010),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  // Feature flags
  ENABLE_RESERVATION_CREATION: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // LLM model config
  OPENAI_EXTRACTION_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_RESPONSE_MODEL: z.string().default("gpt-4o-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().default(10_000),

  // Context cache TTL
  CONTEXT_CACHE_TTL_MS: z.coerce.number().default(60_000),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;