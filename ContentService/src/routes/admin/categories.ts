import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { loadConfig } from "../../config";

const categoryBodySchema = z.object({
  slug: z.string().min(3),
  name: z.string().min(1),
  description: z.string().max(1000).optional(),
  displayOrder: z.number().int().optional(),
});

const categoryUpdateSchema = categoryBodySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
});

export default async function adminCategoryRoutes(fastify: FastifyInstance) {
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
      body: categoryBodySchema,
    },
    handler: async (request, reply) => {
      const body = categoryBodySchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.createCategory(adminId, body);
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: body.slug },
          "Failed to create category"
        );
        return reply.status(500).send({ message: "Unable to create category" });
      }
    },
  });

  fastify.get<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const category = await catalog.getCategoryById(params.id);
        return category;
      } catch (error) {
        if (
          error instanceof CatalogServiceError &&
          error.code === "NOT_FOUND"
        ) {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to fetch category"
        );
        return reply.status(500).send({ message: "Unable to fetch category" });
      }
    },
  });

  fastify.get("/", {
    schema: {
      querystring: listQuerySchema,
    },
    handler: async (request) => {
      const query = listQuerySchema.parse(request.query);
      return catalog.listCategories(query);
    },
  });

  fastify.patch<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: categoryUpdateSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = categoryUpdateSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateCategory(adminId, params.id, body);
        return result;
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to update category"
        );
        return reply.status(500).send({ message: "Unable to update category" });
      }
    },
  });

  fastify.put<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: categoryBodySchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = categoryBodySchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateCategory(adminId, params.id, body);
        return result;
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to replace category"
        );
        return reply
          .status(500)
          .send({ message: "Unable to replace category" });
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
        await catalog.deleteCategory(adminId, params.id);
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
          "Failed to delete category"
        );
        return reply.status(500).send({ message: "Unable to delete category" });
      }
    },
  });
}
