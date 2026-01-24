import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Message } from "@google-cloud/pubsub";
import { loadConfig } from "../config";
import { z } from "zod";

const mediaUploadedEventSchema = z.object({
    uploadId: z.string().uuid(),
    contentId: z.string().uuid().optional().nullable(),
    contentClassification: z.enum(["EPISODE", "REEL"]).optional().nullable(),
    fileName: z.string().optional().nullable(),
    storageUrl: z.string().optional(),
    assetType: z.string().optional(),
    // We can add more fields if needed
});

async function mediaUploadedSubscriber(fastify: FastifyInstance) {
    const config = loadConfig();
    const { pubsub, catalogService } = fastify;
    fastify.log.info("Initializing mediaUploadedSubscriber...");


    // We reuse the topic name from env or default, but we need to know the SUBSCRIPTION name
    // Assuming a convention or env var. 
    // If PUBSUB_UPLOAD_SUBSCRIPTION is used by TranscodingWorker, 
    // ContentService needs a SEPARATE subscription to the SAME topic to also get the message.
    // Let's assume a new env var or default: content-media-uploaded-sub
    const subscriptionName = config.MEDIA_UPLOADED_SUBSCRIPTION || "content-media-uploaded-sub";

    try {
        const subscription = pubsub.subscription(subscriptionName);

        subscription.exists().then(([exists]) => {
            if (!exists) {
                fastify.log.warn(`Subscription ${subscriptionName} does not exist. ContentService might not see early uploads.`);
            }
        }).catch(err => {
            fastify.log.debug({ err }, "Could not check for subscription existence");
        });

        subscription.on("message", async (message: Message) => {
            try {
                const data = JSON.parse(message.data.toString());
                const result = mediaUploadedEventSchema.safeParse(data);

                if (result.success) {
                    const eventData = result.data;
                    fastify.log.info({ uploadId: eventData.uploadId }, "Processing media.uploaded event");

                    await catalogService.handleMediaUploaded({
                        uploadId: eventData.uploadId,
                        contentId: eventData.contentId ?? undefined,
                        contentType: eventData.contentClassification ?? undefined,
                        filename: eventData.fileName ?? undefined,
                    });

                    fastify.log.info({ uploadId: eventData.uploadId }, "Successfully processed media.uploaded event");
                }
                // Ack anyway
                message.ack();
            } catch (error) {
                fastify.log.error({ err: error, msgId: message.id }, "Failed to process media.uploaded message");
                message.nack();
            }
        });

        fastify.log.info(`ContentService subscribed to ${subscriptionName} for media uploads`);

    } catch (error) {
        fastify.log.error({ err: error }, "Failed to setup media.uploaded subscription in ContentService");
    }
}

export default fp(mediaUploadedSubscriber, {
    name: "media-uploaded-subscriber",
    dependencies: ["pubsub"],
});
