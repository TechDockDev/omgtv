import { z } from "zod";
import "dotenv/config";

const configSchema = z.object({
    // GCP Settings
    GCP_PROJECT_ID: z.string().min(1),
    GCS_UPLOADS_BUCKET: z.string().min(1),
    GCS_STREAMING_BUCKET: z.string().min(1),

    // Pub/Sub (using existing topics)
    PUBSUB_SUBSCRIPTION: z.string().default("uploaded-media-sub").or(z.undefined()).transform((val) => {
        return process.env.PUBSUB_TRANSCODING_SUBSCRIPTION || val || "uploaded-media-sub";
    }),
    PUBSUB_READY_TOPIC: z.string().default("streaming-audit"),

    // Transcode Settings
    TRANSCODE_TEMP_DIR: z.string().default("/tmp/transcode"),
    HLS_SEGMENT_DURATION: z.coerce.number().int().default(4),

    // Upload Service Callback
    UPLOAD_SERVICE_URL: z.string().url().optional(),
    SERVICE_AUTH_TOKEN: z.string().optional(),

    // CDN Base URL
    CDN_BASE_URL: z.string().url().default("https://storage.googleapis.com/videos-bucket-pocketlol"),

    // Logging
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

let config: Config | null = null;

export function loadConfig(): Config {
    if (config) return config;
    config = configSchema.parse(process.env);
    return config;
}
