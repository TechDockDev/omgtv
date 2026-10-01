import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Storage } from "@google-cloud/storage";
import { MediaAssetStatus, MediaAssetType } from "@prisma/client";
import { loadConfig } from "../../config";

// Request Schema
const uploadBodySchema = z.object({
    title: z.string().min(1),
    type: z.nativeEnum(MediaAssetType).default(MediaAssetType.REEL),
    filename: z.string().optional(),
    // GIF is just stored in GCS and served by direct URL — no HLS transcode.
    // (Tested: feeding a GIF, which has no audio stream, through the existing
    // ABR ffmpeg command fails outright — "Unable to map stream at a:0" — so
    // it deliberately never goes near TranscodingWorker.)
    format: z.enum(["mp4", "gif"]).default("mp4"),
});

const SOURCE_CONTENT_TYPE: Record<"mp4" | "gif", string> = {
    mp4: "video/mp4",
    gif: "image/gif",
};

export default async function adminUploadRoutes(fastify: FastifyInstance) {
    const config = loadConfig();
    const storage = new Storage({ projectId: config.GCP_PROJECT_ID });
    const bucketName = config.UPLOAD_BUCKET ?? "videos-bucket-omgtv-prod";

    /**
     * POST /admin/media/upload
     * Initiates a video upload flow by creating a PENDING asset and returning a GCS Signed URL.
     */
    fastify.post(
        "/upload",
        {
            schema: {
                body: uploadBodySchema,
                response: {
                    200: z.object({
                        id: z.string(),
                        uploadUrl: z.string(),
                        expiresAt: z.string(),
                        storagePath: z.string(),
                    }),
                },
            },
            // Admin auth is handled by parent scope in index.ts
        },
        async (request, reply) => {
            const { title, type, filename, format } = uploadBodySchema.parse(request.body);
            const contentType = SOURCE_CONTENT_TYPE[format];

            // Extract admin ID from validated headers (set by hooks in index.ts)
            const adminId = request.headers["x-admin-id"] as string;

            // 1. Create MediaAsset in DB.
            // A GIF has nothing left to process after the upload lands, so it
            // goes straight to READY; mp4 stays PENDING until TranscodingWorker
            // finishes HLS and flips it.
            const mediaAsset = await fastify.prisma.mediaAsset.create({
                data: {
                    title,
                    type,
                    status: format === "gif" ? MediaAssetStatus.READY : MediaAssetStatus.PENDING,
                    filename: filename || (title.toLowerCase().endsWith(`.${format}`) ? title : `${title}.${format}`),
                    createdByAdminId: adminId,
                    // Intentionally leaving uploadId null.
                },
            });

            // 2. Generate Signed URL.
            // mp4: "videos/{id}/source.mp4" — TranscodingWorker's GCS event
            //   handler watches this prefix and runs the HLS transcode.
            // gif: "gifs/{id}/source.gif" — deliberately OUTSIDE "videos/" and
            //   "images/", so the worker's path filter ignores it entirely
            //   (logs "Ignoring file (path filter)") and never touches it.
            const objectPrefix = format === "gif" ? "gifs" : "videos";
            const objectName = `${objectPrefix}/${mediaAsset.id}/source.${format}`;
            const file = storage.bucket(bucketName).file(objectName);
            const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

            const [url] = await file.getSignedUrl({
                version: "v4",
                action: "write",
                expires: expiresAt,
                contentType,
            });

            // For a GIF there is no separate "ready" signal from a worker, so
            // the direct URL is set optimistically now (same pattern as the
            // thumbnail route below) — it resolves as soon as the admin's
            // upload to the signed URL completes.
            if (format === "gif") {
                await fastify.prisma.mediaAsset.update({
                    where: { id: mediaAsset.id },
                    data: { manifestUrl: publicUrl },
                });
            }

            fastify.log.info(
                { mediaAssetId: mediaAsset.id, objectName, adminId, format },
                "Generated signed URL for new media upload"
            );

            return {
                id: mediaAsset.id,
                uploadUrl: url,
                expiresAt: expiresAt.toISOString(),
                storagePath: `gs://${bucketName}/${objectName}`,
            };
        }
    );

    /**
     * POST /admin/media/:id/thumbnail
     * Generates a signed URL for uploading a custom thumbnail.
     * Updates defaultThumbnailUrl immediately.
     */
    fastify.post<{ Params: { id: string } }>(
        "/:id/thumbnail",
        {
            schema: {
                params: z.object({ id: z.string().uuid() }),
                response: {
                    200: z.object({
                        uploadUrl: z.string(),
                        publicUrl: z.string(),
                        expiresAt: z.string(),
                    }),
                },
            },
        },
        async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

            // Validate admin access (header check done in index.ts hook)
            const adminId = request.headers["x-admin-id"] as string;

            const mediaAsset = await fastify.prisma.mediaAsset.findUnique({
                where: { id },
            });

            if (!mediaAsset) {
                return reply.status(404).send({ message: "MediaAsset not found" });
            }

            const objectName = `images/${id}/thumbnail.jpg`;
            const file = storage.bucket(bucketName).file(objectName);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

            const [url] = await file.getSignedUrl({
                version: "v4",
                action: "write",
                expires: expiresAt,
                contentType: "image/jpeg",
            });

            // Deterministic public URL
            // Use CDN_BASE_URL if available, otherwise construct from bucket
            const msg = "Thumbnail upload initiated";
            const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

            // Optimistically update the DB
            await fastify.prisma.mediaAsset.update({
                where: { id },
                data: {
                    defaultThumbnailUrl: publicUrl,
                    updatedByAdminId: adminId,
                },
            });

            fastify.log.info({ mediaAssetId: id, adminId }, "Generated signed URL for thumbnail");

            return {
                uploadUrl: url,
                publicUrl,
                expiresAt: expiresAt.toISOString(),
            };
        }
    );
}
