import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4900),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  SERVICE_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  CDN_BASE_URL: z.string().url().default("https://stream.cdn.pocketlol"),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CDN_SIGNING_SECRET: z.string().min(8).default("development-secret"),
  CDN_FAILOVER_BASE_URL: z.string().url().optional(),
  CDN_CONTROL_BASE_URL: z.string().url().optional(),
  CDN_CONTROL_API_KEY: z.string().optional(),
  OME_API_BASE_URL: z.string().url().default("https://ome-api.pocketlol"),
  OME_API_KEY: z.string().min(1).default("local-key"),
  OME_API_SECRET: z.string().min(1).default("local-secret"),
  OME_REELS_PRESET: z
    .string()
    .default("720p|1280x720|2500,480p|854x480|1500,360p|640x360|900"),
  OME_SERIES_PRESET: z
    .string()
    .default("1080p|1920x1080|4500,720p|1280x720|2500,480p|854x480|1500"),
  OME_REELS_APPLICATION: z.string().default("reels"),
  OME_SERIES_APPLICATION: z.string().default("series"),
  OME_REELS_INGEST_POOL: z.string().default("ome-reels-ingest"),
  OME_SERIES_INGEST_POOL: z.string().default("ome-series-ingest"),
  OME_REELS_EGRESS_POOL: z.string().default("ome-reels-egress"),
  OME_SERIES_EGRESS_POOL: z.string().default("ome-series-egress"),
  GCS_MANIFEST_BUCKET: z.string().default("pocketlol-streaming-manifests"),
  CDN_SIGNING_KEY_ID: z.string().default("primary"),
  PUBSUB_UPLOAD_SUBSCRIPTION: z
    .string()
    .default("projects/dev/subscriptions/uploaded-media"),
  UPLOAD_EVENT_ACK_DEADLINE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(600)
    .default(60),
  CHANNEL_REPOSITORY_BACKEND: z
    .enum(["firestore", "postgres", "memory"])
    .default("memory"),
  FIRESTORE_PROJECT_ID: z.string().optional(),
  POSTGRES_DSN: z.string().optional(),
  MAX_PROVISION_RETRIES: z.coerce.number().int().positive().default(5),
  AUDIT_LOG_TOPIC: z.string().default("projects/dev/topics/streaming-audit"),
  CONTENT_SERVICE_CALLBACK_URL: z.string().url().optional(),
  CONTENT_SERVICE_BASE_URL: z
    .string()
    .url()
    .default("https://content.pocketlol"),
  CONTENT_SERVICE_INTERNAL_TOKEN: z.string().optional(),
  CONTENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  API_GATEWAY_CACHE_WARMUP_URL: z.string().url().optional(),
  OBSERVABILITY_EXPORT_URL: z.string().url().optional(),
  AUTH_SERVICE_BASE_URL: z.string().url().default("https://auth.pocketlol"),
  AUTH_SERVICE_INTROSPECTION_PATH: z
    .string()
    .default("/api/v1/auth/introspect"),
  AUTH_SERVICE_INTERNAL_TOKEN: z.string().optional(),
  AUTH_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  METRICS_ACCESS_TOKEN: z.string().optional(),
  CDN_PROBE_REGIONS: z.string().default("iad,sfo,ams"),
  PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  BIGQUERY_EXPORT_URL: z.string().url().optional(),
  RECONCILIATION_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  DRY_RUN_PROVISIONING: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

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
    throw new Error(`StreamingService configuration invalid: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
