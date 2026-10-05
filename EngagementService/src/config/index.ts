import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4700),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  REDIS_URL: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  SERVICE_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  USER_SERVICE_URL: z.string().default("http://user-service:4500"),
  SUBSCRIPTION_SERVICE_URL: z.string().default("http://subscription-service:5100"),
  AD_REWARD_COINS: z.coerce.number().int().positive().default(10),
  CONTENT_SERVICE_URL: z.string().default("http://content-service:4600"),
  NOTIFICATION_SERVICE_URL: z.string().default("http://notification-service:5200"),

  // --- Audience registration ---
  // Private GCS bucket for registration photos/PDFs. Unset = uploads disabled
  // (submit returns 503 rather than silently dropping files).
  AUDIENCE_BUCKET: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value.trim() : undefined
    ),
  AUDIENCE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // Service-account key JSON for the audience bucket, used verbatim as GCS
  // client credentials. Lets the client sign v4 URLs locally (JWT, using the
  // key's own private key) instead of calling the IAM signBlob API, so the
  // workload identity does NOT need roles/iam.serviceAccountTokenCreator on
  // itself. Unset = falls back to Application Default Credentials.
  AUDIENCE_GCS_KEY_JSON: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value.trim() : undefined
    ),
  // Optional: mirror every submitted registration as one row in a Google Sheet,
  // via a Google Apps Script web app attached to that Sheet (admin convenience
  // copy; the DB stays the source of truth). Unset = feature off.
  AUDIENCE_SHEETS_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value.trim() : undefined
    ),
  // Shared secret the Apps Script checks, so only this service can write rows.
  AUDIENCE_SHEETS_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value.trim() : undefined
    ),
  // Per-mobile submit attempts allowed per window (needs Redis; skipped without it).
  AUDIENCE_SUBMIT_MAX_PER_MOBILE: z.coerce.number().int().positive().default(5),
  AUDIENCE_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // GET /registration/status?mobile= lets anyone probe whether a number is
  // registered. Off by default; the logged-in token path is the normal route.
  AUDIENCE_ALLOW_MOBILE_LOOKUP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Banner image URL embedded in audience registration emails (hosted on CDN).
  AUDIENCE_EMAIL_BANNER_URL: z
    .string()
    .url()
    .default("https://cdn.sonyliv.com/audience/indian-game-show-banner.jpg"),
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
    throw new Error(`EngagementService configuration invalid: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
