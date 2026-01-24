import { PubSub, Message } from "@google-cloud/pubsub";
import { getPrisma } from "../lib/prisma";
import pino from "pino";

/**
 * Media Ready Event from TranscodingWorker
 */
interface MediaReadyEvent {
    eventId: string;
    eventType: "media.ready";
    version: string;
    occurredAt: string;
    data: {
        uploadId: string;
        contentId?: string | null; // Now optional for library-only uploads
        contentType: "EPISODE" | "REEL";
        manifestUrl: string;
        thumbnailUrl?: string;
        durationSeconds: number;
        renditions: Array<{
            name: string;
            resolution: string;
            width: number;
            height: number;
            bitrateKbps: number;
            codec: string;
        }>;
        checksum: string;
    };
}

const prisma = getPrisma();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Start listening for media.ready events from TranscodingWorker
 */
export async function startMediaReadySubscriber(
    projectId: string,
    subscriptionName: string
): Promise<void> {
    const pubsub = new PubSub({ projectId });
    const subscription = pubsub.subscription(subscriptionName);

    logger.info(
        { subscription: subscriptionName },
        "Starting media.ready subscriber"
    );

    subscription.on("message", handleMessage);
    subscription.on("error", (error) => {
        logger.error({ error }, "Media ready subscription error");
    });
}

/**
 * Handle incoming media.ready message
 */
async function handleMessage(message: Message): Promise<void> {
    try {
        const event = JSON.parse(message.data.toString()) as MediaReadyEvent;

        logger.info(
            {
                eventId: event.eventId,
                uploadId: event.data.uploadId,
                contentId: event.data.contentId,
                contentType: event.data.contentType,
                manifestUrl: event.data.manifestUrl
            },
            "Processing media.ready event"
        );

        await updateMediaAsset(event.data);

        message.ack();
        logger.info(
            { uploadId: event.data.uploadId, contentType: event.data.contentType },
            "MediaAsset updated successfully"
        );
    } catch (error) {
        logger.error({ error, messageId: message.id }, "Failed to process media.ready");
        message.nack();
    }
}

/**
 * Update or create MediaAsset using uploadId as primary key
 * Supports both linked (has contentId) and library-only (no contentId) uploads
 */
async function updateMediaAsset(data: MediaReadyEvent["data"]): Promise<void> {
    const { uploadId, contentId, contentType, manifestUrl, thumbnailUrl, renditions } = data;

    // Determine linking based on contentId and contentType
    const episodeId = contentType === "EPISODE" && contentId ? contentId : null;
    const reelId = contentType === "REEL" && contentId ? contentId : null;

    // Upsert using uploadId as the unique key
    const mediaAsset = await prisma.mediaAsset.upsert({
        where: { uploadId: uploadId },
        create: {
            uploadId: uploadId,
            type: contentType,
            episodeId: episodeId,
            reelId: reelId,
            sourceUploadId: uploadId, // Legacy compatibility
            manifestUrl: manifestUrl,
            defaultThumbnailUrl: thumbnailUrl,
            status: "READY",
        },
        update: {
            episodeId: episodeId,
            reelId: reelId,
            manifestUrl: manifestUrl,
            defaultThumbnailUrl: thumbnailUrl,
            status: "READY",
        },
    });

    // Create/update variants for each rendition
    for (const rendition of renditions) {
        await prisma.mediaAssetVariant.upsert({
            where: {
                mediaAssetId_label: {
                    mediaAssetId: mediaAsset.id,
                    label: rendition.name,
                },
            },
            create: {
                mediaAssetId: mediaAsset.id,
                label: rendition.name,
                width: rendition.width,
                height: rendition.height,
                bitrateKbps: rendition.bitrateKbps,
                codec: rendition.codec,
            },
            update: {
                width: rendition.width,
                height: rendition.height,
                bitrateKbps: rendition.bitrateKbps,
                codec: rendition.codec,
            },
        });
    }

    // Update linked content with thumbnail if applicable
    if (thumbnailUrl) {
        if (episodeId) {
            await prisma.episode.update({
                where: { id: episodeId },
                data: { defaultThumbnailUrl: thumbnailUrl },
            }).catch(() => {
                // Episode might not exist yet for library uploads
                logger.warn({ episodeId }, "Could not update Episode thumbnail");
            });
        }
    }

    logger.info(
        {
            mediaAssetId: mediaAsset.id,
            uploadId,
            episodeId,
            reelId,
            isLibraryOnly: !contentId
        },
        "MediaAsset processed"
    );
}

