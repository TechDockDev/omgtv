import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../../lib/prisma";
import { CatalogServiceError } from "../../../services/catalog-service";
import {
  listAudioCarousel,
  setAudioCarousel,
  addAudioCarouselSeries,
  removeAudioCarouselSeries,
} from "../../../services/audio-catalog-service";

const setAudioCarouselSchema = z.object({
  items: z
    .array(z.object({ seriesId: z.string().uuid() }))
    .min(1, "At least one carousel entry is required")
    .max(50, "Audio carousel is limited to 50 entries"),
});

function requireAdminId(request: FastifyRequest, reply: FastifyReply) {
  const value = request.headers["x-admin-id"];
  if (typeof value === "string" && value.length > 0) return value;
  throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
}

export default async function adminAudioCarouselRoutes(fastify: FastifyInstance) {
  const prisma = getPrisma();

  fastify.get("/", {
    handler: async (request, reply) => {
      const items = await listAudioCarousel(prisma);
      return reply.send({ items });
    },
  });

  fastify.post<{ Body: z.infer<typeof setAudioCarouselSchema> }>("/", {
    schema: { body: setAudioCarouselSchema },
    handler: async (request, reply) => {
      const body = setAudioCarouselSchema.parse(request.body);
      const adminId = requireAdminId(request, reply);
      try {
        const items = await setAudioCarousel(prisma, adminId, body.items);
        return reply.status(200).send({ items });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") return reply.status(412).send({ message: error.message });
          if (error.code === "NOT_FOUND") return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error }, "Failed to set audio carousel entries");
        return reply.status(500).send({ message: "Unable to set audio carousel" });
      }
    },
  });

  fastify.post<{ Params: { seriesId: string } }>("/series/:seriesId", {
    schema: { params: z.object({ seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      const { seriesId } = request.params;
      const adminId = requireAdminId(request, reply);
      try {
        await addAudioCarouselSeries(prisma, adminId, seriesId);
        return reply.status(200).send({ success: true, message: "Series added to audio carousel" });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") return reply.status(412).send({ message: error.message });
          if (error.code === "NOT_FOUND") return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error }, "Failed to add series to audio carousel");
        return reply.status(500).send({ message: "Unable to add series to audio carousel" });
      }
    },
  });

  fastify.delete<{ Params: { seriesId: string } }>("/series/:seriesId", {
    schema: { params: z.object({ seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      const { seriesId } = request.params;
      requireAdminId(request, reply);
      await removeAudioCarouselSeries(prisma, seriesId);
      return reply.status(200).send({ success: true, message: "Series removed from audio carousel" });
    },
  });
}
