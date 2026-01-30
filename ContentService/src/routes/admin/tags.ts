import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { loadConfig } from "../../config";

const createTagSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(512).optional(),
});

const cursorSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().uuid().optional());

const listTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: cursorSchema,
});

export default async function adminTagRoutes(fastify: FastifyInstance) {
  console.log("Registering Admin Tag Routes...");
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
      body: createTagSchema,
    },
    handler: async (request, reply) => {
      const body = createTagSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const tag = await catalog.createTag(adminId, body);
        return reply.status(201).send(tag);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to create tag");
        return reply.status(500).send({ message: "Unable to create tag" });
      }
    },
  });

  fastify.get("/", {
    schema: {
      querystring: listTagsQuerySchema,
    },
    handler: async (request, reply) => {
      const query = listTagsQuerySchema.parse(request.query);
      try {
        const adminId = requireAdminId(request, reply);
        request.log.debug({ adminId }, "Listing tags");
        const result = await catalog.listTags({
          limit: query.limit,
          cursor: query.cursor ?? null,
        });
        return reply.status(200).send(result);
      } catch (error) {
        request.log.error({ err: error }, "Failed to list tags");
        return reply.status(500).send({ message: "Unable to list tags" });
      }
    },
  });

  const updateTagSchema = createTagSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one field must be provided",
    });

  fastify.patch<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: updateTagSchema,
    },
    handler: async (request, reply) => {
      request.log.info({ params: request.params }, "Hit PATCH /admin/catalog/tags/:id");
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateTagSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const tag = await catalog.updateTag(adminId, params.id, body);
        return reply.status(200).send(tag);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to update tag");
        return reply.status(500).send({ message: "Unable to update tag" });
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
        const result = await catalog.deleteTag(adminId, params.id);

        if (result.alreadyDeleted) {
          return reply.status(410).send({
            ...result.tag,
            message: "Tag was already deleted"
          });
        }

        return reply.status(200).send({
          ...result.tag,
          message: "Tag deleted successfully"
        });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to delete tag");
        return reply.status(500).send({ message: "Unable to delete tag" });
      }
    },
  });
}
