import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { loadConfig } from "../../config";
import { getPrisma } from "../../lib/prisma";

const categoryBodySchema = z.object({
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
  const catalog = fastify.catalogService;

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

        if (result.restored) {
          // Category was restored from deleted state
          return reply.status(200).send({
            ...result.category,
            message: "Category restored successfully (was previously deleted)",
          });
        }

        // New category created
        return reply.status(201).send({
          ...result.category,
          message: "Category created successfully",
        });
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
          { err: error, contentId: body.name },
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

  // GET /:id/series — list all series in a category ordered by displayOrder
  fastify.get<{ Params: { id: string } }>("/:id/series", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const prisma = getPrisma();

      const category = await prisma.category.findUnique({
        where: { id, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
      if (!category) return reply.status(404).send({ message: "Category not found" });

      const series = await prisma.series.findMany({
        where: { categoryId: id, deletedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          displayOrder: true,
          status: true,
          visibility: true,
          releaseDate: true,
          heroImageUrl: true,
        },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
      });

      return { category, total: series.length, series };
    },
  });

  // PATCH /:id/series/reorder — bulk update displayOrder for series in this category
  fastify.patch<{ Params: { id: string } }>("/:id/series/reorder", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        order: z.array(z.object({
          id: z.string().uuid(),
          displayOrder: z.number().int().min(0),
        })).min(1),
      }),
    },
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { order } = request.body as { order: { id: string; displayOrder: number }[] };
      const prisma = getPrisma();

      const category = await prisma.category.findUnique({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!category) return reply.status(404).send({ message: "Category not found" });

      // Update only series that actually belong to this category — ignore any that don't.
      await prisma.$transaction(
        order.map((o) =>
          prisma.series.updateMany({
            where: { id: o.id, categoryId: id, deletedAt: null },
            data: { displayOrder: o.displayOrder },
          })
        )
      );

      return { updated: order.length };
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
      request.log.info({ categoryId: params.id }, "Received unique delete category request");
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.deleteCategory(adminId, params.id);

        request.log.info({ result }, "Delete category result from service");

        if (result.alreadyDeleted) {
          // Category was already deleted - return 410 Gone
          return reply.status(410).send({
            id: result.category.id,
            slug: result.category.slug,
            deletedAt: result.category.deletedAt,
            message: "Category was already deleted",
          });
        }

        // Category successfully deleted - return 200
        return reply.status(200).send({
          id: result.category.id,
          slug: result.category.slug,
          deletedAt: result.category.deletedAt,
          message: "Category deleted successfully",
        });
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
