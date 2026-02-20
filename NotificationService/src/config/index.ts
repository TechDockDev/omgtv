import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
    HTTP_HOST: z.string().default("0.0.0.0"),
    HTTP_PORT: z.coerce.number().int().positive().default(5200),
    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("info"),
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
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_B64: z.string().optional(),
    GRPC_BIND_ADDRESS: z.string().optional(),
    PUBSUB_EMULATOR_HOST: z.string().optional(),
    GOOGLE_CLOUD_PROJECT: z.string().optional(),
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
        throw new Error(`NotificationService configuration invalid: ${message}`);
    }
    cachedConfig = parsed.data;
    return cachedConfig;
}

export function resetConfigCache() {
    cachedConfig = null;
}
