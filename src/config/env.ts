import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4010),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
});

export const env = envSchema.parse(process.env);