import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";

const listMediaQuerySchema = z.object({
    status: z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]).optional(),
    type: z.enum(["EPISODE", "REEL"]).optional(),
    unassigned: z.coerce.boolean().optional(), // Only show unassigned library items
    limit: z.coerce.number().int().positive().max(100).default(20),
    cursor: z.string().uuid().optional(),
});

const assignMediaBodySchema = z.object({
    episodeId: z.string().uuid().optional(),
    reelId: z.string().uuid().optional(),
    seriesId: z.string().uuid().optional(),
}).refine(
    (data) => data.episodeId || data.reelId || data.seriesId,
    { message: "At least one of episodeId, reelId, or seriesId must be provided" }
);

export default async function adminMediaRoutes(fastify: FastifyInstance) {
    const prisma = getPrisma();

    const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
        const value = request.headers["x-admin-id"];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
        throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
    };

    /**
     * GET /admin/media - List all media assets (Library view)
     */
    fastify.get("/", {
        handler: async (request, reply) => {
            const query = listMediaQuerySchema.parse(request.query);
            const adminId = requireAdminId(request, reply);

            const where: Record<string, unknown> = {
                deletedAt: null,
            };

            if (query.status) {
                where.status = query.status;
            }

            if (query.type) {
                where.type = query.type;
            }

            // Filter for unassigned (library-only) items
            if (query.unassigned) {
                where.episodeId = null;
                where.reelId = null;
                where.seriesId = null;
            }

            const items = await prisma.mediaAsset.findMany({
                where,
                include: {
                    variants: true,
                },
                orderBy: { createdAt: "desc" },
                take: query.limit + 1,
                cursor: query.cursor ? { id: query.cursor } : undefined,
                skip: query.cursor ? 1 : 0,
            });

            let nextCursor: string | null = null;
            if (items.length > query.limit) {
                const next = items.pop();
                nextCursor = next?.id ?? null;
            }

            fastify.log.info({ adminId, count: items.length }, "Listed media assets");

            return reply.send({
                items: items.map((item) => ({
                    id: item.id,
                    uploadId: item.uploadId,
                    type: item.type,
                    status: item.status,
                    filename: item.filename,
                    title: item.title,
                    manifestUrl: item.manifestUrl,
                    defaultThumbnailUrl: item.defaultThumbnailUrl,
                    episodeId: item.episodeId,
                    reelId: item.reelId,
                    seriesId: item.seriesId,
                    variants: item.variants,
                    createdAt: item.createdAt,
                })),
                nextCursor,
            });
        },
    });

    /**
     * PATCH /admin/media/:id/assign - Assign media to Episode/Reel/Series
     */
    fastify.patch<{ Params: { id: string } }>("/:id/assign", {
        schema: {
            params: z.object({ id: z.string().uuid() }),
            body: assignMediaBodySchema,
        },
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            const body = assignMediaBodySchema.parse(request.body);
            const adminId = requireAdminId(request, reply);

            const mediaAsset = await prisma.mediaAsset.findFirst({
                where: { id, deletedAt: null },
            });

            if (!mediaAsset) {
                return reply.status(404).send({ message: "MediaAsset not found" });
            }

            // Update the assignment
            const updated = await prisma.mediaAsset.update({
                where: { id },
                data: {
                    episodeId: body.episodeId ?? mediaAsset.episodeId,
                    reelId: body.reelId ?? mediaAsset.reelId,
                    seriesId: body.seriesId ?? mediaAsset.seriesId,
                    updatedByAdminId: adminId,
                },
            });

            fastify.log.info(
                { mediaAssetId: id, adminId, ...body },
                "Assigned MediaAsset"
            );

            return reply.send({
                id: updated.id,
                episodeId: updated.episodeId,
                reelId: updated.reelId,
                seriesId: updated.seriesId,
                status: updated.status,
            });
        },
    });

    /**
     * GET /admin/media/:id - Get single media asset details
     */
    fastify.get<{ Params: { id: string } }>("/:id", {
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            requireAdminId(request, reply);

            const mediaAsset = await prisma.mediaAsset.findFirst({
                where: { id, deletedAt: null },
                include: { variants: true },
            });

            if (!mediaAsset) {
                return reply.status(404).send({ message: "MediaAsset not found" });
            }

            return reply.send(mediaAsset);
        },
    });



    /**
     * POST /admin/media/:id/process - Trigger transcoding for a media asset
     */
    /**
     * POST /admin/media/:id/process - Trigger transcoding for a media asset
     */
    fastify.post<{ Params: { id: string } }>("/:id/process", {
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            const adminId = requireAdminId(request, reply);

            try {
                const result = await fastify.catalogService.processMediaAsset(adminId, id);
                return reply.send(result);
            } catch (error) {
                if (error instanceof Error && error.message.includes("Media asset not found")) {
                    return reply.status(404).send({ message: error.message });
                }
                fastify.log.error({ err: error }, "Error triggering media processing");
                return reply.status(500).send({ message: error instanceof Error ? error.message : "Internal Server Error" });
            }
        },
    });

    /**
     * DELETE /admin/media/:id - Delete media asset
     */
    fastify.delete<{ Params: { id: string } }>("/:id", {
        handler: async (request, reply) => {
            const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
            const adminId = requireAdminId(request, reply);

            const mediaAsset = await prisma.mediaAsset.findFirst({
                where: { id, deletedAt: null },
            });

            if (!mediaAsset) {
                return reply.status(404).send({ message: "MediaAsset not found" });
            }

            // In a real scenario, we might want to check if it's assigned to an existing episode/reel
            // and prevent deletion if so, or force unassign.
            // For now, simplistically delete it.
            await prisma.mediaAsset.delete({
                where: { id }
            });
            // Alternatively use CatalogService.deleteMediaAsset if wired up, 
            // but accessing prisma directly here matches the file style.

            fastify.log.info({ mediaAssetId: id, adminId }, "Deleted MediaAsset");

            return reply.status(204).send();
        },
    });
}

