import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MediaAssetStatus } from "@prisma/client";

const listImagesQuerySchema = z.object({
    status: z.nativeEnum(MediaAssetStatus).optional(),
    unassigned: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    cursor: z.string().uuid().optional(),
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
}
