import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MediaAssetStatus } from "@prisma/client";
import * as crypto from "crypto";

const listImagesQuerySchema = z.object({
    status: z.nativeEnum(MediaAssetStatus).optional(),
    unassigned: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    cursor: z.string().uuid().optional(),
});

const uploadImageBodySchema = z.object({
    title: z.string().min(1),
    filename: z.string().optional(),
});

const assignImageBodySchema = z.object({
    episodeId: z.string().uuid().optional(),
    seriesId: z.string().uuid().optional(),
    reelId: z.string().uuid().optional(),
}).refine(
    (data) => data.episodeId || data.reelId || data.seriesId,
    { message: "At least one of episodeId, reelId, or seriesId must be provided" }
);

export default async function adminImageRoutes(fastify: FastifyInstance) {
    const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
        const value = request.headers["x-admin-id"];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
        throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
    };

    /**
     * GET /admin/catalog/images - List image assets
     */
    fastify.get("/", {
        handler: async (request, reply) => {
            const query = listImagesQuerySchema.parse(request.query);
            const adminId = requireAdminId(request, reply);

            const result = await fastify.catalogService.listImageAssets({
                limit: query.limit,
                cursor: query.cursor,
                unassigned: query.unassigned,
                status: query.status,
            });

            return reply.send({
                ...result,
                items: result.items.map(item => ({
                    ...item,
                    sizeBytes: item.sizeBytes ? item.sizeBytes.toString() : null,
                }))
            });
        },
    });

    /**
     * PATCH /admin/catalog/images/:id/assign - Assign image to content
     */
    fastify.patch<{ Params: { id: string } }>("/:id/assign", {
        schema: {
            params: z.object({ id: z.string().uuid() }),
            body: assignImageBodySchema,
        },
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            const body = assignImageBodySchema.parse(request.body);
            const adminId = requireAdminId(request, reply);

            try {
                const result = await fastify.catalogService.assignImageAsset(adminId, id, body);
                return reply.send(result);
            } catch (error) {
                if (error instanceof Error) {
                    if (error.message.includes("not found")) {
                        return reply.status(404).send({ message: error.message });
                    }
                }
                fastify.log.error({ err: error }, "Error assigning image asset");
                throw error;
            }
        },
    });

    /**
     * DELETE /admin/catalog/images/:id - Delete image asset
     */
    fastify.delete<{ Params: { id: string } }>("/:id", {
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            const adminId = requireAdminId(request, reply);

            try {
                await fastify.catalogService.deleteImageAsset(adminId, id);
                return reply.status(204).send();
            } catch (error) {
                if (error instanceof Error) {
                    // Check for FAILED_PRECONDITION (used for linked assets)
                    if (error.message.includes("assigned to content")) {
                        return reply.status(412).send({ message: error.message });
                    }
                    if (error.message.includes("not found")) {
                        return reply.status(404).send({ message: error.message });
                    }
                }
                fastify.log.error({ err: error }, "Error deleting image asset");
                throw error;
            }
        },
    });
    /**
     * POST /admin/catalog/images/upload
     * Initiates an image upload flow by creating a PENDING asset and returning a GCS Signed URL.
     */
    fastify.post(
        "/upload",
        {
            schema: {
                body: uploadImageBodySchema,
                response: {
                    200: z.object({
                        id: z.string(),
                        uploadUrl: z.string(),
                        expiresAt: z.string(),
                        publicUrl: z.string(),
                    }),
                },
            },
        },
        async (request, reply) => {
            const { title, filename } = uploadImageBodySchema.parse(request.body);
            const adminId = requireAdminId(request, reply);
            const { Storage } = await import("@google-cloud/storage");
            const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
            const bucketName = process.env.UPLOAD_BUCKET || "videos-bucket-pocketlol-dev"; // Reusing video bucket for simplicity

            // 1. Create ImageAsset in DB (PENDING)
            // We generate a UUID for the uploadId to ensure uniqueness
            const uploadId = crypto.randomUUID();

            const imageAsset = await fastify.prisma.imageAsset.create({
                data: {
                    title,
                    status: MediaAssetStatus.PENDING,
                    filename: filename || "source.jpg",
                    createdByAdminId: adminId,
                    uploadId,
                    url: "", // Will be updated after upload or set to predicted URL
                },
            });

            // 2. Generate Signed URL
            // Convention: images/{id}/source.jpg
            const objectName = `images/${imageAsset.id}/source.jpg`; // Force jpg or use extension from filename if strict
            const file = storage.bucket(bucketName).file(objectName);
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

            const [url] = await file.getSignedUrl({
                version: "v4",
                action: "write",
                expires: expiresAt,
                contentType: "image/jpeg", // Assume JPEG for now, or detect from filename
            });

            // 3. Update URL in DB (Optimistic / Predictive)
            const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;
            await fastify.prisma.imageAsset.update({
                where: { id: imageAsset.id },
                data: { url: publicUrl }
            });

            fastify.log.info(
                { imageAssetId: imageAsset.id, objectName, adminId },
                "Generated signed URL for new image upload"
            );

            return {
                id: imageAsset.id,
                uploadUrl: url,
                expiresAt: expiresAt.toISOString(),
                publicUrl,
            };
        }
    );
}
