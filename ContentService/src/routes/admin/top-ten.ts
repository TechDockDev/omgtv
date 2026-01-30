import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CatalogService } from "../../services/catalog-service";
import { loadConfig } from "../../config";

const updateTopTenSchema = z.object({
    items: z.array(
        z.object({
            seriesId: z.string().uuid(),
            position: z.number().int().min(1).max(10),
        })
    ).max(10),
});

export default async function adminTopTenRoutes(fastify: FastifyInstance) {
    const config = loadConfig();
    const service = new CatalogService({
        defaultOwnerId: config.DEFAULT_OWNER_ID,
    });

    fastify.get("/", async (request, reply) => {
        const list = await service.getAdminTopTenSeries();
        return reply.send(list);
    });

    fastify.post("/", async (request, reply) => {
        const body = updateTopTenSchema.parse(request.body);
        const adminId = request.headers["x-admin-id"] as string;

        const list = await service.updateTopTenSeries(adminId, body.items);
        return reply.send(list);
    });
}
