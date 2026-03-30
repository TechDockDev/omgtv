import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const createAdSchema = z
  .discriminatedUnion("adType", [
    z.object({
      adType: z.literal("UNITY_GOOGLE"),
      episodeId: z.string().uuid().optional(),
      seriesId: z.string().uuid().optional(),
      timestampSeconds: z.number().nonnegative(),
    }),
    z.object({
      adType: z.literal("CUSTOM"),
      episodeId: z.string().uuid().optional(),
      seriesId: z.string().uuid().optional(),
      adName: z.string().min(1),
      adImageUrl: z.string().url(),
      adLink: z.string().url(),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().nonnegative(),
    }),
  ])
  .refine((d) => d.episodeId || d.seriesId, {
    message: "Either episodeId or seriesId is required",
  });

const updateAdSchema = z
  .object({
    adType: z.enum(["UNITY_GOOGLE", "CUSTOM"]).optional(),
    timestampSeconds: z.number().nonnegative().optional(),
    adName: z.string().min(1).optional(),
    adImageUrl: z.string().url().optional(),
    adLink: z.string().url().optional(),
    startSeconds: z.number().nonnegative().optional(),
    endSeconds: z.number().nonnegative().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field must be provided",
  });

export default async function adminAdRoutes(fastify: FastifyInstance) {
  const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.headers["x-admin-id"];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
  };

  // List ads for an episode
  fastify.get<{ Params: { episodeId: string } }>("/episode/:episodeId", {
    schema: {
      params: z.object({ episodeId: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { episodeId } = z
        .object({ episodeId: z.string().uuid() })
        .parse(request.params);
      try {
        requireAdminId(request, reply);
        const episode = await fastify.prisma.episode.findUnique({
          where: { id: episodeId },
          select: { seriesId: true }
        });

        if (!episode) {
          return reply.status(404).send({ message: "Episode not found" });
        }

        const ads = await fastify.prisma.ad.findMany({
          where: { 
            OR: [
              { episodeId },
              { seriesId: episode.seriesId, episodeId: null }
            ],
            deletedAt: null 
          },
          orderBy: { createdAt: "asc" },
        });
        return reply.send({ items: ads });
      } catch (error) {
        request.log.error({ err: error, episodeId }, "Failed to list episode ads");
        return reply.status(500).send({ message: "Unable to list episode ads" });
      }
    },
  });

  // List ads for a series
  fastify.get<{ Params: { seriesId: string } }>("/series/:seriesId", {
    schema: {
      params: z.object({ seriesId: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { seriesId } = z
        .object({ seriesId: z.string().uuid() })
        .parse(request.params);
      try {
        requireAdminId(request, reply);
        const ads = await fastify.prisma.ad.findMany({
          where: {
            OR: [
              { seriesId },
              { episode: { seriesId } }
            ],
            deletedAt: null
          },
          orderBy: { createdAt: "asc" },
        });
        return reply.send({ items: ads });
      } catch (error) {
        request.log.error({ err: error, seriesId }, "Failed to list series ads");
        return reply.status(500).send({ message: "Unable to list series ads" });
      }
    },
  });

  // Create an ad
  fastify.post("/", {
    handler: async (request, reply) => {
      const body = createAdSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);

        const data: any = {
          adType: body.adType,
          episodeId: body.episodeId ?? null,
          seriesId: body.seriesId ?? null,
          createdByAdminId: adminId,
          updatedByAdminId: adminId,
        };

        if (body.adType === "UNITY_GOOGLE") {
          data.timestampSeconds = body.timestampSeconds;
        } else {
          data.adName = body.adName;
          data.adImageUrl = body.adImageUrl;
          data.adLink = body.adLink;
          data.startSeconds = body.startSeconds;
          data.endSeconds = body.endSeconds;
        }

        const ad = await fastify.prisma.ad.create({ data });
        return reply.status(201).send(ad);
      } catch (error) {
        request.log.error({ err: error }, "Failed to create ad");
        return reply.status(500).send({ message: "Unable to create ad" });
      }
    },
  });

  // Update an ad
  fastify.patch<{ Params: { id: string } }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateAdSchema.parse(request.body);
      try {
        const adminId = requireAdminId(request, reply);

        const existing = await fastify.prisma.ad.findFirst({
          where: { id, deletedAt: null },
        });
        if (!existing) {
          return reply.status(404).send({ message: "Ad not found" });
        }

        const ad = await fastify.prisma.ad.update({
          where: { id },
          data: {
            ...body,
            updatedByAdminId: adminId,
          },
        });
        return reply.send(ad);
      } catch (error) {
        request.log.error({ err: error, adId: id }, "Failed to update ad");
        return reply.status(500).send({ message: "Unable to update ad" });
      }
    },
  });

  // Delete an ad (soft-delete)
  fastify.delete<{ Params: { id: string } }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const adminId = requireAdminId(request, reply);

        const existing = await fastify.prisma.ad.findFirst({
          where: { id, deletedAt: null },
        });
        if (!existing) {
          return reply.status(404).send({ message: "Ad not found" });
        }

        await fastify.prisma.ad.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            updatedByAdminId: adminId,
          },
        });
        return reply.status(204).send();
      } catch (error) {
        request.log.error({ err: error, adId: id }, "Failed to delete ad");
        return reply.status(500).send({ message: "Unable to delete ad" });
      }
    },
  });
}
