import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_OWNER_ID = "00000000-0000-0000-0000-000000000001" as const;

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4600),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  GRPC_BIND_ADDRESS: z.string().default("0.0.0.0:50061"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENGAGEMENT_SERVICE_URL: z.string().url(),
  SUBSCRIPTION_SERVICE_URL: z.string().url(),
  SEARCH_SERVICE_URL: z.string().url().optional(),
  SERVICE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SERVICE_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  CDN_BASE_URL: z.string().url().default("https://cdn.local.pocketlol"),
  DEFAULT_OWNER_ID: z.string().uuid().default(DEFAULT_OWNER_ID),
  FEED_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  SERIES_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(120),
  RELATED_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(180),
  MOBILE_HOME_FEED_LIMIT: z.coerce.number().int().min(5).max(50).default(20),
  MOBILE_HOME_CAROUSEL_LIMIT: z.coerce.number().int().min(1).max(10).default(5),
  MOBILE_HOME_CONTINUE_WATCH_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(6),
  MOBILE_HOME_SECTION_ITEM_LIMIT: z.coerce
    .number()
    .int()
    .min(4)
    .max(30)
    .default(12),
  MOBILE_REELS_PAGE_SIZE: z.coerce.number().int().min(5).max(50).default(20),
  MOBILE_STREAMING_TYPE: z.string().default("HLS"),
  MOBILE_DEFAULT_PLAN_PURCHASED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MOBILE_DEFAULT_CAN_GUEST_WATCH: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  CATALOG_EVENT_STREAM_KEY: z.string().default("catalog:events"),
  TRENDING_SORTED_SET_KEY: z.string().default("catalog:trending"),
  RATINGS_HASH_KEY: z.string().default("catalog:ratings"),
  OTEL_SERVICE_NAME: z.string().default("content-service"),
  OTEL_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_METRICS_ENDPOINT: z.string().url().optional(),
  OTEL_METRICS_EXPORT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60000),
  // GCP Pub/Sub config for media.ready subscription
  GCP_PROJECT_ID: z.string().optional(),
  MEDIA_READY_SUBSCRIPTION: z.string().optional(),
  MEDIA_UPLOADED_SUBSCRIPTION: z.string().optional(),
  UPLOAD_BUCKET: z.string().optional(),
  UPLOAD_SERVICE_URL: z.string().url().optional(),
  TRANSCODING_REQUESTS_TOPIC: z.string().optional(),
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
    throw new Error(`ContentService configuration invalid: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
