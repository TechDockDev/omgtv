import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4700),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  GRPC_BIND_ADDRESS: z.string().default("0.0.0.0:50071"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  AUTH_SERVICE_ADDRESS: z.string().default("0.0.0.0:50051"),
  USER_SERVICE_ADDRESS: z.string().default("0.0.0.0:50052"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SERVICE_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1, "RAZORPAY_WEBHOOK_SECRET is required"),
  OTEL_SERVICE_NAME: z.string().default("subscription-service"),
  OTEL_TRACES_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().url().optional()),
  OTEL_METRICS_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().url().optional()),
  OTEL_METRICS_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
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
    throw new Error(`SubscriptionService configuration invalid: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
