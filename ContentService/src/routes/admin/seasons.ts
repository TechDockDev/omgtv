import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { loadConfig } from "../../config";

const createSeasonSchema = z.object({
  seriesId: z.string().uuid(),
  sequenceNumber: z.number().int().min(0),
  title: z.string().min(1),
  synopsis: z.string().max(5000).optional(),
  releaseDate: z.coerce.date().optional(),
});

export default async function adminSeasonRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const catalog = new CatalogService({
    defaultOwnerId: config.DEFAULT_OWNER_ID,
  });

  const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.headers["x-admin-id"];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
  };

  fastify.post("/", {
    schema: {
      body: createSeasonSchema,
    },
    handler: async (request, reply) => {
      const body = createSeasonSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.createSeason(adminId, body);
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: body.seriesId },
          "Failed to create season"
        );
        return reply.status(500).send({ message: "Unable to create season" });
      }
    },
  });
}
