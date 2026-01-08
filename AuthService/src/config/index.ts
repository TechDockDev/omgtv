import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4000),
  HTTP_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  GRPC_BIND_ADDRESS: z.string().default("0.0.0.0:50051"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_JWT_PRIVATE_KEY: z.string().min(1, "AUTH_JWT_PRIVATE_KEY is required"),
  AUTH_JWT_PUBLIC_KEY: z.string().min(1, "AUTH_JWT_PUBLIC_KEY is required"),
  AUTH_JWT_KEY_ID: z.string().default("auth-service"),
  DEFAULT_LANGUAGE_ID: z.string().default("hi"),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  REFRESH_TOKEN_ROTATION: z
    .string()
    .optional()
    .transform((value) => (value ? value === "true" : true)),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  USER_SERVICE_ADDRESS: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0 ? value : undefined
    ),
  USER_SERVICE_TOKEN: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  FIREBASE_PROJECT_ID: z
    .string()
    .min(1, "FIREBASE_PROJECT_ID is required"),
  FIREBASE_CREDENTIALS_B64: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
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
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}
