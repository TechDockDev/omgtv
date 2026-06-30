import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../../lib/prisma";
import { CatalogServiceError } from "../../../services/catalog-service";
import {
  createAudioCategory,
  listAudioCategories,
  getAudioCategory,
  updateAudioCategory,
  deleteAudioCategory,
  mapSeriesToAudioCategory,
  unmapSeriesFromAudioCategory,
} from "../../../services/audio-catalog-service";

const categoryBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().max(1000).optional(),
  displayOrder: z.number().int().optional(),
});

const categoryUpdateSchema = categoryBodySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided" }
);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().uuid().optional(),
});

export default async function adminAudioCategoriesRoutes(fastify: FastifyInstance) {
  const prisma = getPrisma();

  fastify.post("/", {
    schema: { body: categoryBodySchema },
    handler: async (request, reply) => {
      const body = categoryBodySchema.parse(request.body);
      const adminId = request.headers["x-admin-id"] as string;
      const category = await createAudioCategory(prisma, adminId, body);
      return reply.status(201).send(category);
    },
  });

  fastify.get("/", {
    schema: { querystring: listQuerySchema },
    handler: async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await listAudioCategories(prisma, query);
      return reply.send(result);
    },
  });

  fastify.get<{ Params: { id: string } }>("/:id", {
    schema: { params: z.object({ id: z.string().uuid() }) },
    handler: async (request, reply) => {
      const category = await getAudioCategory(prisma, request.params.id);
      if (!category) return reply.status(404).send({ message: "Audio category not found" });
      return reply.send(category);
    },
  });

  const updateHandler = async (request: any, reply: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = categoryUpdateSchema.parse(request.body);
    const adminId = request.headers["x-admin-id"] as string;
    try {
      const category = await updateAudioCategory(prisma, adminId, id, body);
      return reply.send(category);
    } catch (error) {
      if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
        return reply.status(404).send({ message: error.message });
      }
      throw error;
    }
  };

  fastify.patch<{ Params: { id: string } }>("/:id", {
    schema: { params: z.object({ id: z.string().uuid() }), body: categoryUpdateSchema },
    handler: updateHandler,
  });

  fastify.put<{ Params: { id: string } }>("/:id", {
    schema: { params: z.object({ id: z.string().uuid() }), body: categoryBodySchema },
    handler: updateHandler,
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    schema: { params: z.object({ id: z.string().uuid() }) },
    handler: async (request, reply) => {
      try {
        const result = await deleteAudioCategory(prisma, request.params.id);
        if (result.alreadyDeleted) return reply.status(410).send({ message: "Audio category already deleted" });
        return reply.status(200).send({ success: true });
      } catch (error) {
        if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
          return reply.status(404).send({ message: error.message });
        }
        throw error;
      }
    },
  });

  fastify.post<{ Params: { id: string; seriesId: string } }>("/:id/series/:seriesId", {
    schema: { params: z.object({ id: z.string().uuid(), seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      try {
        await mapSeriesToAudioCategory(prisma, request.params.id, request.params.seriesId);
        return reply.status(200).send({ success: true });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") return reply.status(404).send({ message: error.message });
          if (error.code === "FAILED_PRECONDITION") return reply.status(412).send({ message: error.message });
        }
        throw error;
      }
    },
  });

  fastify.delete<{ Params: { id: string; seriesId: string } }>("/:id/series/:seriesId", {
    schema: { params: z.object({ id: z.string().uuid(), seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      await unmapSeriesFromAudioCategory(prisma, request.params.id, request.params.seriesId);
      return reply.status(200).send({ success: true });
    },
  });
}
