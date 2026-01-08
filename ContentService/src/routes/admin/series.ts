import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { PublicationStatus, Visibility } from "@prisma/client";
import { loadConfig } from "../../config";

const createSeriesSchema = z.object({
  slug: z.string().min(3),
  title: z.string().min(1),
  synopsis: z.string().max(5000).optional(),
  heroImageUrl: z.string().url().optional(),
  bannerImageUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  status: z.nativeEnum(PublicationStatus).optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  releaseDate: z.coerce.date().optional(),
  ownerId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});

const updateSeriesSchema = createSeriesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export default async function adminSeriesRoutes(fastify: FastifyInstance) {
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
      body: createSeriesSchema,
    },
    handler: async (request, reply) => {
      const body = createSeriesSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.createSeries(adminId, body);
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
          "Failed to create series"
        );
        return reply.status(500).send({ message: "Unable to create series" });
      }
    },
  });

  fastify.patch<{
    Params: { id: string };
  }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: updateSeriesSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateSeriesSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.updateSeries(adminId, params.id, body);
        return result;
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
          if (error.code === "CONFLICT") {
            return reply.status(409).send({ message: error.message });
          }
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to update series"
        );
        return reply.status(500).send({ message: "Unable to update series" });
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
        await catalog.deleteSeries(adminId, params.id);
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
          "Failed to delete series"
        );
        return reply.status(500).send({ message: "Unable to delete series" });
      }
    },
  });
}
