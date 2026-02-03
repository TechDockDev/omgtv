import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4800),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  SERVICE_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(20),
  MEILI_HOST: z.string().default("http://meilisearch:7700"),
  MEILI_MASTER_KEY: z.string().default("masterKey"),
});

type Env = z.infer<typeof envSchema>;

let cachedConfig: Env | null = null;

export function loadConfig(): Env {
  if (cachedConfig) {
    return cachedConfig;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`SearchService configuration invalid: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
