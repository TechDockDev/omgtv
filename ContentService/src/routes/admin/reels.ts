import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { PublicationStatus, Visibility } from "@prisma/client";
import { loadConfig } from "../../config";

const createReelSchema = z.object({
  seriesId: z.string().uuid(),
  episodeId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().max(5000).optional(),
  status: z.nativeEnum(PublicationStatus).optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  publishedAt: z.coerce.date().optional(),
  tags: z.array(z.string()).optional(),
  durationSeconds: z.number().int().positive().optional(),
});

const updateReelTagsSchema = z.object({
  tags: z.array(z.string()),
});

const updateReelSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.nativeEnum(PublicationStatus).optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  publishedAt: z.coerce.date().nullable().optional(),
  durationSeconds: z.number().int().positive().optional(),
});

export default async function adminReelRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const catalog = new CatalogService({
    defaultOwnerId: config.DEFAULT_OWNER_ID,
  });

  fastify.log.info("Registering Admin Reel Routes");

  const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.headers["x-admin-id"];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
  };

  fastify.post("", {
    schema: {
      body: createReelSchema,
    },
    handler: async (request, reply) => {
      const body = createReelSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.createReel(adminId, body);
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
        request.log.error({ err: error, contentId: body.title }, "Failed to create reel");
        return reply.status(500).send({ message: "Unable to create reel" });
      }
    },
  });

  fastify.get("", {
    schema: {
      querystring: z.object({
        seriesId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        cursor: z.string().uuid().optional(),
      }),
    },
    handler: async (request, reply) => {
      const query = z.object({
        seriesId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        cursor: z.string().uuid().optional(),
      }).parse(request.query);

      try {
        requireAdminId(request, reply);
        const result = await catalog.listReels(query);
        return reply.send(result);
      } catch (error) {
        request.log.error({ err: error, query }, "Failed to list reels");
        return reply.status(500).send({ message: "Unable to list reels" });
      }
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const adminId = requireAdminId(request, reply);
        await catalog.deleteReel(adminId, params.id);
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error, contentId: params.id }, "Failed to delete reel");
        return reply.status(500).send({ message: "Unable to delete reel" });
      }
    },
  });

  fastify.patch<{ Params: { id: string } }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: updateReelSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateReelSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateReel(adminId, params.id, body);
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error, reelId: params.id }, "Failed to update reel");
        return reply.status(500).send({ message: "Unable to update reel" });
      }
    },
  });

  fastify.patch<{
    Params: { id: string };
  }>("/:id/tags", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: updateReelTagsSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateReelTagsSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateReelTags(
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
          "Failed to update reel tags"
        );
        return reply
          .status(500)
          .send({ message: "Unable to update reel tags" });
      }
    },
  });
}
