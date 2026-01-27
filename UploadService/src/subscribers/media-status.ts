import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Message } from "@google-cloud/pubsub";
import { loadConfig } from "../config";
import { z } from "zod";

const mediaReadyEventSchema = z.object({
    eventId: z.string(),
    eventType: z.literal("media.ready"),
    data: z.object({
        uploadId: z.string().uuid(),
        manifestUrl: z.string(), // Relaxing to string to avoid potential .url() mismatch issues
        durationSeconds: z.number(),
        renditions: z.array(z.any()).optional(),
    }).passthrough(),
}).passthrough();

const mediaFailedEventSchema = z.object({
    eventId: z.string(),
    eventType: z.literal("media.failed"),
    data: z.object({
        uploadId: z.string().uuid(),
        reason: z.string(),
        error: z.unknown().optional(),
    }).passthrough(),
}).passthrough();

async function mediaStatusSubscriber(fastify: FastifyInstance) {
    const config = loadConfig();
    const { pubsub, uploadSessions } = fastify;

    // Subscribe to Media Ready/Failed topic (same topic now: media.ready-for-stream)
    const readyTopicName = config.MEDIA_READY_FOR_STREAM_TOPIC;
    const readyParams = {
        // Create subscription if not exists (in a real app, usually managed by TF/scripts)
        // Here we assume subscription might need to be created or attached
        topic: readyTopicName,
        subscription: `streaming-audit-sub`,
    };

    try {
        // Just create a handle to the subscription - don't call .get() or .create() to avoid permission issues
        const subscription = pubsub.subscription(readyParams.subscription);

        subscription.on("message", async (message: Message) => {
            try {
                const data = JSON.parse(message.data.toString());
                fastify.log.info({ msgId: message.id, eventType: data.eventType }, "Received media status event");

                try {
                    if (data.eventType === "media.ready") {
                        const parsed = mediaReadyEventSchema.safeParse(data);
                        if (parsed.success) {
                            const { uploadId, manifestUrl } = parsed.data.data;
                            await uploadSessions.updateProcessingOutcome(uploadId, {
                                ready: true,
                                manifestUrl,
                            });
                            fastify.log.info({ uploadId }, "Marked upload session as READY");
                        } else {
                            fastify.log.warn({ errors: parsed.error }, "Invalid media.ready event payload");
                        }
                    } else if (data.eventType === "media.failed") {
                        const parsed = mediaFailedEventSchema.safeParse(data);
                        if (parsed.success) {
                            const { uploadId, reason } = parsed.data.data;
                            await uploadSessions.markFailed(uploadId, reason);
                            fastify.log.warn({ uploadId, reason }, "Marked upload session as FAILED");
                        } else {
                            fastify.log.warn({ errors: parsed.error }, "Invalid media.failed event payload");
                        }
                    }
                } catch (err: any) {
                    if (err.code === 'P2025') {
                        fastify.log.warn({ err, msgId: message.id }, "Upload session record not found (P2025), ignoring event to prevent retry loop");
                        // We must ack here to stop the loop, as retrying won't make the record appear
                        message.ack();
                        return;
                    }
                    throw err; // Re-throw other errors to trigger the outer catch and nack
                }

                message.ack();
            } catch (error) {
                fastify.log.error({ err: error, msgId: message.id }, "Failed to process media status message");
                message.nack();
            }
        });

        fastify.log.info(`Subscribed to ${readyParams.topic} via ${readyParams.subscription}`);

    } catch (error) {
        fastify.log.error({ err: error }, "Failed to setup media status subscription");
    }
}

export default fp(mediaStatusSubscriber, {
    name: "media-status-subscriber",
    dependencies: ["pubsub", "upload-sessions"],
});
