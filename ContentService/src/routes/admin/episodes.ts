import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { PublicationStatus, Visibility } from "@prisma/client";
import { loadConfig } from "../../config";
import {
  moderationQueueQuerySchema,
  registerEpisodeAssetSchema,
} from "../../schemas/episode-assets";

const createEpisodeSchema = z.object({
  seriesId: z.string().uuid(),
  seasonId: z.string().uuid().optional(),
  slug: z.string().min(3),
  title: z.string().min(1),
  synopsis: z.string().max(5000).optional(),
  durationSeconds: z.number().int().positive(),
  status: z.nativeEnum(PublicationStatus).optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  publishedAt: z.coerce.date().optional(),
  availabilityStart: z.coerce.date().optional(),
  availabilityEnd: z.coerce.date().optional(),
  heroImageUrl: z.string().url().optional(),
  defaultThumbnailUrl: z.string().url().optional(),
  captions: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const transitionSchema = z.object({
  status: z.nativeEnum(PublicationStatus),
});

export default async function adminEpisodeRoutes(fastify: FastifyInstance) {
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
      body: createEpisodeSchema,
    },
    handler: async (request, reply) => {
      const body = createEpisodeSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.createEpisode(adminId, body);
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: body.slug },
          "Failed to create episode"
        );
        return reply.status(500).send({ message: "Unable to create episode" });
      }
    },
  });

  fastify.patch<{
    Params: { id: string };
  }>("/:id/tags", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ tags: z.array(z.string()) }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ tags: z.array(z.string()) }).parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateEpisodeTags(
          adminId,
          params.id,
          body.tags
        );
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to update episode tags"
        );
        return reply
          .status(500)
          .send({ message: "Unable to update episode tags" });
      }
    },
  });

  fastify.post<{
    Params: { id: string };
  }>("/:id/status", {
    config: { metricsId: "/admin/catalog/episodes/:id/status" },
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: transitionSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = transitionSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateEpisodeStatus(
          adminId,
          params.id,
          body.status
        );
        return result;
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "INVALID_STATE") {
            return reply.status(409).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to transition episode"
        );
        return reply
          .status(500)
          .send({ message: "Unable to transition episode" });
      }
    },
  });

  fastify.patch<{
    Params: { id: string };
  }>("/:id/assets", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: registerEpisodeAssetSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = registerEpisodeAssetSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.registerEpisodeAsset(adminId, {
          episodeId: params.id,
          ...body,
        });
        return result;
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to register episode asset"
        );
        return reply
          .status(500)
          .send({ message: "Unable to register episode asset" });
      }
    },
  });

  fastify.get("/moderation/queue", {
    schema: {
      querystring: moderationQueueQuerySchema,
    },
    handler: async (request, reply) => {
      const query = moderationQueueQuerySchema.parse(request.query);
      try {
        const result = await catalog.listModerationQueue(query);
        return result;
      } catch (error) {
        request.log.error({ err: error }, "Failed to fetch moderation queue");
        return reply
          .status(500)
          .send({ message: "Unable to fetch moderation queue" });
      }
    },
  });

  fastify.delete<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const adminId = requireAdminId(request, reply);
        await catalog.deleteEpisode(adminId, params.id);
        return reply.status(204).send();
      } catch (error) {
        if (
          error instanceof CatalogServiceError &&
          error.code === "NOT_FOUND"
        ) {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to delete episode"
        );
        return reply.status(500).send({ message: "Unable to delete episode" });
      }
    },
  });
}
