import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Storage } from "@google-cloud/storage";
import { MediaAssetStatus, MediaAssetType } from "@prisma/client";

// Request Schema
const uploadBodySchema = z.object({
    title: z.string().min(1),
    type: z.nativeEnum(MediaAssetType).default(MediaAssetType.REEL),
    filename: z.string().optional(),
});

export default async function adminUploadRoutes(fastify: FastifyInstance) {
    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
    const bucketName = process.env.UPLOAD_BUCKET || "videos-bucket-pocketlol-dev";

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
            const { title, type, filename } = uploadBodySchema.parse(request.body);

            // Extract admin ID from validated headers (set by hooks in index.ts)
            const adminId = request.headers["x-admin-id"] as string;

            // 1. Create MediaAsset in DB (PENDING)
            // We do NOT set uploadId because we are bypassing UploadService
            const mediaAsset = await fastify.prisma.mediaAsset.create({
                data: {
                    title,
                    type,
                    status: MediaAssetStatus.PENDING,
                    filename: filename || (title.toLowerCase().endsWith(".mp4") ? title : `${title}.mp4`),
                    createdByAdminId: adminId,
                    // Intentionally leaving uploadId null.
                },
            });

            // 2. Generate Signed URL
            // Convention: videos/{id}/source.mp4
            const objectName = `videos/${mediaAsset.id}/source.mp4`;
            const file = storage.bucket(bucketName).file(objectName);

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

            const [url] = await file.getSignedUrl({
                version: "v4",
                action: "write",
                expires: expiresAt,
                contentType: "video/mp4",
            });

            fastify.log.info(
                { mediaAssetId: mediaAsset.id, objectName, adminId },
                "Generated signed URL for new video upload"
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
