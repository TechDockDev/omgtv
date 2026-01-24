import { PubSub } from "@google-cloud/pubsub";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";

// Load environment variables
dotenv.config();

const projectId = process.env.GCP_PROJECT_ID || "pocketlol-68ca6";
const topicName = process.env.MEDIA_UPLOADED_TOPIC || "uploaded-media";
const bucketName = process.env.UPLOAD_BUCKET || "videos-bucket-pocketlol";

// Get arguments
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: npx tsx scripts/trigger-transcode.ts <uploadId> <objectKey> [contentId] [contentType]");
    console.error("Example: npx tsx scripts/trigger-transcode.ts 7c2cc0f8... videos/1768... [optional-uuid] [video/mp4]");
    process.exit(1);
}

const [uploadId, objectKey, contentIdArg, contentTypeArg] = args;
const contentId = contentIdArg || uploadId; // Fallback to uploadId if missing
const contentType = contentTypeArg || "video/mp4";

// Construct the message payload
const payload = {
    uploadId: uploadId,
    objectKey: objectKey,
    storageUrl: `gs://${bucketName}/${objectKey}`,
    cdnUrl: `https://upload.cdn.pocketlol/${objectKey}`, // Mock CDN URL
    assetType: "video",
    adminId: "manual-trigger", // Placeholder
    contentId: contentId,
    contentClassification: "REEL",
    sizeBytes: 1024 * 1024 * 10, // Mock size (10MB)
    contentType: contentType,
    validation: {
        source: "manual-trigger"
    },
    emittedAt: new Date().toISOString()
};

async function main() {
    console.log(`🔌 Connecting to Pub/Sub (Project: ${projectId})...`);
    const pubsub = new PubSub({ projectId });
    const topic = pubsub.topic(topicName);

    console.log(`📦 Publishing message to topic: ${topicName}`);
    console.log(JSON.stringify(payload, null, 2));

    try {
        const messageId = await topic.publishMessage({ json: payload });
        console.log(`✅ Message published! ID: ${messageId}`);
        console.log("Check transcoding-worker logs now: docker compose logs -f transcoding-worker");
    } catch (error) {
        console.error("❌ Failed to publish message:", error);
        process.exit(1);
    }
}

main();
