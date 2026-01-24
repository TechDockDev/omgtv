import { PubSub, Message } from "@google-cloud/pubsub";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { loadConfig } from "./config.js";
import { StorageClient } from "./storage.js";
import { FFmpegService } from "./ffmpeg.js";
import type { MediaUploadedMessage, MediaReadyEvent, TranscodeJob, MediaFailedEvent } from "./types.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

const storage = new StorageClient(config, logger);
const ffmpeg = new FFmpegService(config, logger);
const pubsub = new PubSub({ projectId: config.GCP_PROJECT_ID });

/**
 * Main entry point for TranscodingWorker
 * Listens to Pub/Sub subscription and processes transcoding jobs
 */
async function main(): Promise<void> {
    logger.info({ config: { ...config, SERVICE_AUTH_TOKEN: "***" } }, "Starting TranscodingWorker");

    const subscription = pubsub.subscription(config.PUBSUB_SUBSCRIPTION);

    logger.info(
        { subscription: config.PUBSUB_SUBSCRIPTION },
        "Listening for transcode jobs"
    );

    subscription.on("message", handleMessage);
    subscription.on("error", (error) => {
        logger.error({ error }, "Subscription error");
    });

    // Keep process alive
    process.on("SIGTERM", async () => {
        logger.info("Received SIGTERM, shutting down");
        await subscription.close();
        process.exit(0);
    });
}

/**
 * Handle incoming Pub/Sub message
 */
async function handleMessage(message: Message): Promise<void> {
    const startTime = Date.now();
    let msgData: MediaUploadedMessage | null = null;

    try {
        // Parse message (flat format from UploadService)
        msgData = JSON.parse(message.data.toString()) as MediaUploadedMessage;

        // Skip non-video assets
        if (msgData.assetType !== "video") {
            logger.info({ assetType: msgData.assetType }, "Skipping non-video asset");
            message.ack();
            return;
        }

        // Check contentId, fallback to uploadId if missing
        if (!msgData.contentId) {
            logger.warn({ uploadId: msgData.uploadId }, "Missing contentId, using uploadId as fallback");
            msgData.contentId = msgData.uploadId;
        }

        logger.info(
            {
                messageId: message.id,
                uploadId: msgData.uploadId,
                contentId: msgData.contentId,
            },
            "Processing transcode job"
        );

        // Create job from message
        const { bucket, object } = storage.parseGcsUrl(msgData.storageUrl);
        const outputPrefix = `hls/${msgData.contentId}`; // Output to hls/ folder

        const job: TranscodeJob = {
            uploadId: msgData.uploadId,
            contentId: msgData.contentId,
            contentType: msgData.contentClassification || "REEL",
            sourceUrl: msgData.storageUrl,
            sourceBucket: bucket,
            sourceObject: object,
            outputBucket: config.GCS_STREAMING_BUCKET,
            outputPrefix,
        };

        // Process the job
        const result = await processTranscodeJob(job);

        // Publish completion event
        await publishReadyEvent(msgData, result);

        // Acknowledge message
        message.ack();

        const elapsed = Date.now() - startTime;
        logger.info(
            { uploadId: job.uploadId, elapsed, manifestUrl: result.manifestUrl },
            "Transcode job complete"
        );
    } catch (error) {
        // Publish failure event
        const failedEvent: MediaFailedEvent = {
            eventId: randomUUID(),
            eventType: "media.failed",
            version: "1.0",
            occurredAt: new Date().toISOString(),
            data: {
                uploadId: msgData?.uploadId || "unknown",
                reason: "Transcode job failed",
                error: error instanceof Error ? error.message : error,
            },
        };

        try {
            const topic = pubsub.topic(config.PUBSUB_READY_TOPIC);
            await topic.publishMessage({ json: failedEvent });
            logger.info({ eventId: failedEvent.eventId }, "Published media.failed event");
        } catch (pubError) {
            logger.error({ error: pubError }, "Failed to publish media.failed event");
        }

        logger.error(
            {
                err: error instanceof Error ?
                    { name: error.name, message: error.message, stack: error.stack } :
                    error,
                messageId: message.id,
                uploadId: msgData?.uploadId,
                deliveryAttempt: message.deliveryAttempt,
            },
            "Transcode job failed"
        );

        // Nack to retry (or it will go to DLQ after max attempts)
        message.nack();
    }
}

/**
 * Process a single transcode job
 */
async function processTranscodeJob(job: TranscodeJob): Promise<{
    manifestUrl: string;
    durationSeconds: number;
    renditions: MediaReadyEvent["data"]["renditions"];
    checksum: string;
    thumbnailUrl?: string;
}> {
    // Create unique temp directory for this execution to avoid race conditions
    const executionId = randomUUID();
    const tempDir = join(config.TRANSCODE_TEMP_DIR, executionId);
    const sourcePath = join(tempDir, "source.mp4");
    const outputDir = join(tempDir, "hls");

    try {
        await mkdir(tempDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });

        // Download source video
        logger.info({ job: job.uploadId, sourcePath }, "Downloading source video");
        await storage.downloadSource(job.sourceBucket, job.sourceObject, sourcePath);

        // Verify file exists before transcoding
        const { stat } = await import("node:fs/promises");
        try {
            const stats = await stat(sourcePath);
            logger.info({ sourcePath, size: stats.size }, "Verified source file exists");
        } catch (e) {
            logger.error({ sourcePath, error: e }, "Source file MISSING after download");
            throw e;
        }

        // Transcode to HLS
        logger.info({ job: job.uploadId }, "Starting FFmpeg transcode");
        const result = await ffmpeg.transcode(sourcePath, outputDir, job.contentId);

        // Upload HLS files to GCS
        logger.info({ job: job.uploadId }, "Uploading HLS files to GCS");
        await storage.uploadHlsDirectory(
            outputDir,
            job.outputBucket,
            job.outputPrefix
        );

        // Build final manifest URL
        const manifestUrl = storage.getCdnUrl(`${job.outputPrefix}/master.m3u8`);

        return {
            manifestUrl,
            thumbnailUrl: storage.getCdnUrl(`${job.outputPrefix}/thumbnail.jpg`),
            durationSeconds: result.durationSeconds,
            renditions: result.renditions,
            checksum: result.checksum,
        };
    } finally {
        // Cleanup temp files
        try {
            await rm(tempDir, { recursive: true, force: true });
            logger.debug({ tempDir }, "Cleaned up temp directory");
        } catch (e) {
            logger.warn({ error: e, tempDir }, "Failed to cleanup temp directory");
        }
    }
}

/**
 * Publish media.ready event when transcoding completes
 */
async function publishReadyEvent(
    originalMsg: MediaUploadedMessage,
    result: {
        manifestUrl: string;
        thumbnailUrl?: string;
        durationSeconds: number;
        renditions: MediaReadyEvent["data"]["renditions"];
        checksum: string;
    }
): Promise<void> {
    const readyEvent: MediaReadyEvent = {
        eventId: randomUUID(),
        eventType: "media.ready",
        version: "1.0",
        occurredAt: new Date().toISOString(),
        data: {
            uploadId: originalMsg.uploadId,
            contentId: originalMsg.contentId!,
            contentType: originalMsg.contentClassification || "REEL",
            manifestUrl: result.manifestUrl,
            thumbnailUrl: result.thumbnailUrl,
            durationSeconds: result.durationSeconds,
            renditions: result.renditions,
            checksum: result.checksum,
        },
    };

    const topic = pubsub.topic(config.PUBSUB_READY_TOPIC);
    await topic.publishMessage({ json: readyEvent });

    logger.info(
        { eventId: readyEvent.eventId, contentId: readyEvent.data.contentId },
        "Published media.ready event"
    );
}

// Start the worker
main().catch((error) => {
    logger.fatal({ error }, "Worker failed to start");
    process.exit(1);
});
