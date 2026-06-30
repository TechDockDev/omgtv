import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../../lib/prisma";
import { loadConfig } from "../../../config";
import { EngagementClient } from "../../../clients/engagement-client";
import { CatalogServiceError } from "../../../services/catalog-service";
import { getMergedAudioTrending, setAudioTrendingOverride, removeAudioTrendingOverride } from "../../../services/audio-catalog-service";

const setOverrideSchema = z.object({
  seriesId: z.string().uuid(),
  mode: z.enum(["PINNED", "EXCLUDED"]),
  pinnedPosition: z.number().int().min(1).max(10).optional(),
});

export default async function adminAudioTrendingRoutes(fastify: FastifyInstance) {
  const prisma = getPrisma();
  const config = loadConfig();
  const engagementClient = new EngagementClient({ baseUrl: config.ENGAGEMENT_SERVICE_URL });

  fastify.get("/", async (request, reply) => {
    try {
      const items = await getMergedAudioTrending(prisma, engagementClient);
      return reply.send({ items });
    } catch (error) {
      request.log.error({ err: error }, "Failed to fetch audio trending");
      return reply.status(500).send({ message: "Unable to fetch audio trending" });
    }
  });

  fastify.post("/overrides", {
    schema: { body: setOverrideSchema },
    handler: async (request, reply) => {
      const body = setOverrideSchema.parse(request.body);
      const adminId = request.headers["x-admin-id"] as string;
      try {
        const override = await setAudioTrendingOverride(prisma, adminId, body);
        return reply.status(200).send(override);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") return reply.status(412).send({ message: error.message });
          if (error.code === "NOT_FOUND") return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error }, "Failed to set audio trending override");
        return reply.status(500).send({ message: "Unable to set audio trending override" });
      }
    },
  });

  fastify.delete<{ Params: { seriesId: string } }>("/overrides/:seriesId", {
    schema: { params: z.object({ seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      await removeAudioTrendingOverride(prisma, request.params.seriesId);
      return reply.status(200).send({ success: true });
    },
  });
}
