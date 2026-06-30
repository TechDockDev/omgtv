import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../../lib/prisma";
import { CatalogServiceError } from "../../../services/catalog-service";
import { getAdminAudioTopTen, updateAudioTopTen } from "../../../services/audio-catalog-service";

const updateAudioTopTenSchema = z.object({
  items: z
    .array(
      z.object({
        seriesId: z.string().uuid(),
        position: z.number().int().min(1).max(10),
      })
    )
    .max(10),
});

export default async function adminAudioTopTenRoutes(fastify: FastifyInstance) {
  const prisma = getPrisma();

  fastify.get("/", async (request, reply) => {
    const list = await getAdminAudioTopTen(prisma);
    return reply.send(list);
  });

  fastify.post("/", async (request, reply) => {
    const body = updateAudioTopTenSchema.parse(request.body);
    try {
      const list = await updateAudioTopTen(prisma, body.items);
      return reply.send(list);
    } catch (error) {
      if (error instanceof CatalogServiceError) {
        return reply.status(412).send({ message: error.message });
      }
      request.log.error({ err: error }, "Failed to update audio top 10");
      return reply.status(500).send({ message: "Unable to update audio top 10" });
    }
  });
}
