import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Message } from "@google-cloud/pubsub";
import { loadConfig } from "../config";
import { z } from "zod";
import { CatalogService } from "../services/catalog-service";

const mediaReadyEventSchema = z.object({
    eventId: z.string(),
    eventType: z.literal("media.ready"),
    data: z.object({
        uploadId: z.string().uuid(),
        contentId: z.string().uuid().optional(),
        contentType: z.enum(["EPISODE", "REEL"]).optional(),
        manifestUrl: z.string(), // Relaxed from .url()
        thumbnailUrl: z.string().optional(), // Relaxed from .url()
        durationSeconds: z.number(),
        filename: z.string().optional(),
        renditions: z.array(z.any()),
    }),
});

const mediaFailedEventSchema = z.object({
    eventId: z.string(),
    eventType: z.literal("media.failed"),
    data: z.object({
        uploadId: z.string().uuid(),
        reason: z.string(),
        error: z.any().optional(),
    }),
});

const eventSchema = z.discriminatedUnion("eventType", [
    mediaReadyEventSchema,
    mediaFailedEventSchema,
]);

async function mediaReadySubscriber(fastify: FastifyInstance) {
    const config = loadConfig();
    const { pubsub, catalogService } = fastify;

    const subscriptionName = config.MEDIA_READY_SUBSCRIPTION || "streaming-audit-sub";

    try {
        const subscription = pubsub.subscription(subscriptionName);

        // Try to check if subscription exists - if we have permissions
        subscription.exists().then(([exists]) => {
            if (!exists) {
                fastify.log.warn(`Subscription ${subscriptionName} does not exist. Events might not be received unless created manually.`);
            }
        }).catch(err => {
            fastify.log.debug({ err }, "Could not check for subscription existence (expected if permissions are restricted)");
        });

        subscription.on("error", (error) => {
            fastify.log.error({ err: error }, "Subscription error in media-ready-subscriber");
        });

        subscription.on("message", async (message: Message) => {
            const rawData = message.data.toString();
            fastify.log.debug({ msgId: message.id, rawData }, "Received raw Pub/Sub message");

            try {
                const data = JSON.parse(rawData);
                const result = eventSchema.safeParse(data);

                if (result.success) {
                    if (result.data.eventType === "media.ready") {
                        const eventData = result.data.data;
                        fastify.log.info({ uploadId: eventData.uploadId, contentId: eventData.contentId }, "Processing media.ready event");

                        await catalogService.handleMediaCompletion({
                            uploadId: eventData.uploadId,
                            contentId: eventData.contentId,
                            contentType: eventData.contentType,
                            manifestUrl: eventData.manifestUrl,
                            thumbnailUrl: eventData.thumbnailUrl,
                            durationSeconds: eventData.durationSeconds,
                            filename: eventData.filename,
                            renditions: eventData.renditions,
                        });

                        fastify.log.info({ uploadId: eventData.uploadId }, "Successfully processed media.ready event");
                    } else if (result.data.eventType === "media.failed") {
                        const eventData = result.data.data;
                        fastify.log.warn({ uploadId: eventData.uploadId, reason: eventData.reason }, "Processing media.failed event");

                        await catalogService.handleMediaFailure({
                            uploadId: eventData.uploadId,
                            reason: eventData.reason
                        });
                    }
                } else {
                    // Log validation errors for events we care about
                    if (data.eventType === "media.ready" || data.eventType === "media.failed") {
                        fastify.log.warn({
                            errors: result.error.errors,
                            eventType: data.eventType,
                            uploadId: data.data?.uploadId
                        }, "Invalid media event payload - validation failed");
                    } else {
                        fastify.log.debug({ eventType: data.eventType }, "Received unknown event type, skipping");
                    }
                }

                // Always ack messages that aren't for us or are successfully processed
                message.ack();
            } catch (error) {
                fastify.log.error({ err: error, msgId: message.id, rawData }, "Failed to process media message");
                message.nack();
            }
        });

        fastify.log.info(`ContentService listening on ${subscriptionName}`);

    } catch (error) {
        fastify.log.error({ err: error }, "Failed to setup media.ready subscription in ContentService");
    }
}

export default fp(mediaReadySubscriber, {
    name: "media-ready-subscriber",
    dependencies: ["pubsub"],
});
