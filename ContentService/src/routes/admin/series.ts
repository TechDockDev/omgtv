import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { EngagementClient } from "../../clients/engagement-client";
import { PublicationStatus, Visibility } from "@prisma/client";
import { loadConfig } from "../../config";
import { getRedis } from "../../lib/redis";

const createSeriesSchema = z.object({
  slug: z.string().min(3).optional(), // Optional, backend generates if missing
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
  isAudioSeries: z.boolean().optional(),
  isFree: z.boolean().optional(),
  adOnSeriesOpen: z.boolean().optional(),
  adOnEpisodeSwipe: z.boolean().optional(),
  showBannerOnSeriesPage: z.boolean().optional(),
  swipeAdFrequency: z.number().int().min(0).optional(),
  displayOrder: z.number().int().optional(),
  isCarousel: z.boolean().optional(),
});

const updateSeriesSchema = createSeriesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export default async function adminSeriesRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const catalog = fastify.catalogService;

  const requireAdminId = (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.headers["x-admin-id"];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
  };

  fastify.get("/", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().int().positive().max(100).default(20),
        cursor: z.string().uuid().optional(),
        isAudioSeries: z.enum(["true", "false"]).optional(),
      }),
    },
    handler: async (request, reply) => {
      const query = request.query as { limit: number; cursor?: string; isAudioSeries?: string };
      // Note: isAudioSeries comes as string "true"/"false" from query usually
      const isAudioSeries = query.isAudioSeries === 'true' ? true : query.isAudioSeries === 'false' ? false : undefined;

      const adminId = requireAdminId(request, reply);
      const result = await catalog.listSeries({
        limit: query.limit,
        cursor: query.cursor,
        isAudioSeries,
      });

      // Federation: Fetch engagement stats
      try {
        const engagementClient = new EngagementClient({
          baseUrl: config.ENGAGEMENT_SERVICE_URL,
          timeoutMs: config.SERVICE_REQUEST_TIMEOUT_MS,
        });

        const ids = result.items.map((s) => s.id);
        const statsMap = await engagementClient.getStatsBatch({
          type: "series",
          ids,
        });

        const itemsWithStats = result.items.map((item) => ({
          ...item,
          is_locked: !item.isFree,
          stats: statsMap[item.id] ?? { likes: 0, views: 0, saves: 0 },
        }));

        return reply.send({ ...result, items: itemsWithStats });

      } catch (err) {
        request.log.warn({ err }, "Failed to fetch engagement stats for series list");
        const itemsWithStats = result.items.map((item) => ({
          ...item,
          is_locked: !item.isFree,
          stats: { likes: 0, views: 0, saves: 0 },
        }));
        return reply.send({ ...result, items: itemsWithStats });
      }
    },
  });

  fastify.get<{ Params: { id: string } }>("/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const adminId = requireAdminId(request, reply);
        const result = await catalog.getSeries(params.id);

        // Fetch reviews
        try {
          const engagementClient = new EngagementClient({
            baseUrl: config.ENGAGEMENT_SERVICE_URL,
            timeoutMs: config.SERVICE_REQUEST_TIMEOUT_MS,
          });

          const reviews = await engagementClient.getReviews({
            seriesId: params.id,
            limit: 50 // reasonable limit for admin view
          });

          return reply.send({ ...result, is_locked: !result.isFree, reviews });
        } catch (err) {
          request.log.warn({ err, seriesId: params.id }, "Failed to fetch reviews for admin series detail");
          return reply.send({ ...result, is_locked: !result.isFree, reviews: null });
        }
      } catch (error) {
        if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error, contentId: params.id }, "Failed to get series");
        return reply.status(500).send({ message: "Unable to get series" });
      }
    },
  });

  fastify.get<{ Params: { id: string } }>("/:id/reviews", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({
        limit: z.coerce.number().int().positive().max(100).default(50),
        cursor: z.string().optional(),
      }),
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const query = request.query as { limit: number; cursor?: string };

      try {
        const adminId = requireAdminId(request, reply);

        // Verify series exists first
        await catalog.getSeries(params.id);

        const engagementClient = new EngagementClient({
          baseUrl: config.ENGAGEMENT_SERVICE_URL,
          timeoutMs: config.SERVICE_REQUEST_TIMEOUT_MS,
        });

        const result = await engagementClient.getReviews({
          seriesId: params.id,
          limit: query.limit,
          cursor: query.cursor,
        });

        return reply.send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError && error.code === "NOT_FOUND") {
          return reply.status(404).send({ message: error.message });
        }
        request.log.error({ err: error, seriesId: params.id }, "Failed to get series reviews");
        return reply.status(500).send({ message: "Unable to get series reviews" });
      }
    },
  });

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
          "Failed to delete series"
        );
        return reply.status(500).send({ message: "Unable to delete series" });
      }
    },
  });

  // Series Episode Access Management
  fastify.get<{ Params: { id: string }; Querystring: { type?: string } }>(
    "/:id/episode-access",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          type: z.enum(["FREE", "TRIAL", "PREMIUM"]).optional(),
        }),
      },
      handler: async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const { type } = request.query;

        try {
          requireAdminId(request, reply);
          const result = await catalog.listEpisodes({
            seriesId: id,
            limit: 500, // Reasonable max for a series
          });

          let episodes = result.items.map((e) => ({
            id: e.id,
            title: e.title,
            episodeNumber: e.episodeNumber,
            isFree: e.isFree,
            isTrial: (e as any).isTrial ?? false,
          }));

          if (type === "FREE") {
            episodes = episodes.filter((e) => e.isFree);
          } else if (type === "TRIAL") {
            episodes = episodes.filter((e) => e.isTrial && !e.isFree);
          } else if (type === "PREMIUM") {
            episodes = episodes.filter((e) => !e.isFree && !e.isTrial);
          }

          return reply.send({ items: episodes });
        } catch (error) {
          request.log.error({ err: error, seriesId: id }, "Failed to get series episode access");
          return reply.status(500).send({ message: "Unable to get episode access" });
        }
      },
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/episode-access",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          episodeIds: z.array(z.string().uuid()),
          access: z.enum(["FREE", "TRIAL", "PREMIUM"]),
        }),
      },
      handler: async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const { episodeIds, access } = request.body as any;

        try {
          const adminId = requireAdminId(request, reply);
          const series = await catalog.getSeries(id);

          const isFree = access === "FREE";
          const isTrial = access === "TRIAL" || access === "FREE"; // Free implies Trial access too conceptually, but logic-wise we just need one.

          // Actually, our logic is:
          // FREE: isFree=true, isTrial=false (or true)
          // TRIAL: isFree=false, isTrial=true
          // PREMIUM: isFree=false, isTrial=false
          // Let's stick to the cleanest mapping:
          const updateData = {
            isFree: access === "FREE",
            isTrial: access === "TRIAL",
          };

          for (const episodeId of episodeIds) {
            await catalog.updateEpisode(adminId, episodeId, updateData);
          }

          // Invalidate Cache
          const redis = getRedis();
          if (redis) {
            const cacheKey = `catalog:series:v2:${series.slug}`;
            await redis.del(cacheKey).catch(() => {});
            request.log.info({ cacheKey }, "Invalidated series cache after episode access update");
          }

          return reply.send({ success: true, updatedCount: episodeIds.length });
        } catch (error) {
          request.log.error({ err: error, seriesId: id }, "Failed to bulk update episode access");
          return reply.status(500).send({ message: "Unable to update episode access" });
        }
      },
    }
  );

  fastify.delete<{ Params: { id: string; episodeId: string } }>(
    "/:id/episode-access/:episodeId",
    {
      schema: {
        params: z.object({
          id: z.string().uuid(),
          episodeId: z.string().uuid(),
        }),
      },
      handler: async (request, reply) => {
        const { id, episodeId } = z.object({
          id: z.string().uuid(),
          episodeId: z.string().uuid(),
        }).parse(request.params);

        try {
          const adminId = requireAdminId(request, reply);
          const series = await catalog.getSeries(id);

          await catalog.updateEpisode(adminId, episodeId, {
            isFree: false,
            isTrial: false,
          });

          // Invalidate Cache
          const redis = getRedis();
          if (redis) {
            const cacheKey = `catalog:series:v2:${series.slug}`;
            await redis.del(cacheKey).catch(() => {});
          }

          return reply.status(204).send();
        } catch (error) {
          request.log.error({ err: error, seriesId: id, episodeId }, "Failed to reset episode access");
          return reply.status(500).send({ message: "Unable to reset episode access" });
        }
      },
    }
  );
}
