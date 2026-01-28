// fp import removed
import type { FastifyInstance } from "fastify";
import {
  engagementEventBodySchema,
  continueWatchQuerySchema,
  continueWatchResponseSchema,
  continueWatchUpsertSchema,
  likeResponseSchema,
  listResponseSchema,
  listWithStatsResponseSchema,
  reelIdParamsSchema,
  saveResponseSchema,
  seriesIdParamsSchema,
  statsBatchRequestSchema,
  statsBatchResponseSchema,
  statsSchema,
  viewResponseSchema,
  batchActionRequestSchema,
  batchActionResponseSchema,
  userStateRequestSchema,
  userStateResponseSchema,
  type EngagementEventMetrics,
  type BatchActionResult,
} from "../schemas/engagement";
import {
  addReviewBodySchema,
  getReviewsQuerySchema,
  reviewsResponseSchema,
} from "../schemas/review";
import {
  applyEngagementEvent,
  getProgressEntries,
} from "../services/engagement";
import { getRedisOptional } from "../lib/redis";
import { getPrismaOptional } from "../lib/prisma";
import {
  addView,
  getStats,
  getStatsBatch,
  likeEntity,
  listUserEntities,
  saveEntity,
  unlikeEntity,
  unsaveEntity,
  addReview,
  getReviews,
  getUserStateBatch,
  getViewProgressBatch,
  upsertViewProgress,
} from "../services/collection-engagement";

function requireUserId(headers: Record<string, unknown>) {
  const value = headers["x-user-id"];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  throw new Error("UNAUTHORIZED: Missing x-user-id");
}

export default async function internalRoutes(fastify: FastifyInstance) {
  const redis = getRedisOptional();
  const prisma = getPrismaOptional();

  fastify.post("/events", {
    schema: {
      body: engagementEventBodySchema,
    },
    handler: async (request): Promise<EngagementEventMetrics> => {
      const body = engagementEventBodySchema.parse(request.body);
      const stats = applyEngagementEvent(body.videoId, body);
      request.log.info(
        { videoId: body.videoId, action: body.action },
        "Processed engagement event"
      );
      return {
        likes: stats.likes,
        views: stats.views,
      };
    },
  });

  // Batch actions endpoint
  fastify.post("/batch", {
    schema: {
      body: batchActionRequestSchema,
      response: { 200: batchActionResponseSchema },
    },
    handler: async (request) => {
      const body = batchActionRequestSchema.parse(request.body);
      const userId = requireUserId(request.headers as Record<string, unknown>);

      const results: BatchActionResult[] = [];
      let failed = 0;

      for (const action of body.actions) {
        const entityType = action.contentType === "reel" ? "reel" : "series";
        const entityId = action.contentId;

        try {
          let result: BatchActionResult["result"];

          switch (action.action) {
            case "like": {
              const likeResult = await likeEntity({
                redis,
                prisma,
                entityType: entityType as "reel" | "series",
                entityId,
                userId,
              });
              result = {
                liked: likeResult.liked,
                likes: likeResult.likes,
                views: likeResult.views,
              };
              break;
            }
            case "unlike": {
              const unlikeResult = await unlikeEntity({
                redis,
                prisma,
                entityType: entityType as "reel" | "series",
                entityId,
                userId,
              });
              result = {
                liked: unlikeResult.liked,
                likes: unlikeResult.likes,
                views: unlikeResult.views,
              };
              break;
            }
            case "save": {
              const saveResult = await saveEntity({
                redis,
                prisma,
                entityType: entityType as "reel" | "series",
                entityId,
                userId,
              });
              result = { saved: saveResult.saved };
              break;
            }
            case "unsave": {
              const unsaveResult = await unsaveEntity({
                redis,
                prisma,
                entityType: entityType as "reel" | "series",
                entityId,
                userId,
              });
              result = { saved: unsaveResult.saved };
              break;
            }
            case "view": {
              const viewResult = await addView({
                redis,
                prisma,
                entityType: entityType as "reel" | "series",
                entityId,
              });
              result = { views: viewResult.views };
              break;
            }
          }

          results.push({
            contentType: action.contentType,
            contentId: action.contentId,
            action: action.action,
            success: true,
            result,
          });
        } catch (error) {
          failed++;
          results.push({
            contentType: action.contentType,
            contentId: action.contentId,
            action: action.action,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      request.log.info(
        { processed: results.length, failed },
        "Processed batch engagement actions"
      );

      return batchActionResponseSchema.parse({
        results,
        processed: results.length,
        failed,
      });
    },
  });

  // User state endpoint for ContentService enrichment (internal only)
  fastify.post("/user-state", {
    schema: {
      body: userStateRequestSchema,
      response: { 200: userStateResponseSchema },
    },
    handler: async (request) => {
      try {
        const body = userStateRequestSchema.parse(request.body);
        const userId = requireUserId(request.headers as Record<string, unknown>);

        const states = await getUserStateBatch({
          redis,
          prisma,
          userId,
          items: body.items,
        });

        request.log.info(
          { itemCount: body.items.length, userId },
          "Processed user state query"
        );

        return userStateResponseSchema.parse({ states });
      } catch (err) {
        request.log.error({ err }, "Error in /user-state");
        throw err;
      }
    },
  });

  // Reels
  fastify.post("/reels/:reelId/like", {
    schema: {
      params: reelIdParamsSchema,
      response: { 200: likeResponseSchema },
    },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await likeEntity({
        redis,
        prisma,
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.delete("/reels/:reelId/like", {
    schema: {
      params: reelIdParamsSchema,
      response: { 200: likeResponseSchema },
    },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await unlikeEntity({
        redis,
        prisma,
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.get("/reels/liked", {
    schema: { response: { 200: listWithStatsResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "reel",
        collection: "liked",
        userId,
      });

      // Fetch engagement stats for all liked reels
      let statsMap: Record<string, { likes: number; views: number }> = {};
      if (ids.length > 0) {
        statsMap = await getStatsBatch({
          redis,
          entityType: "reel",
          entityIds: ids,
        });
      }

      const items = ids.map((id) => ({
        id,
        likes: statsMap[id]?.likes ?? 0,
        views: statsMap[id]?.views ?? 0,
      }));

      return listWithStatsResponseSchema.parse({ items });
    },
  });

  fastify.post("/reels/:reelId/save", {
    schema: {
      params: reelIdParamsSchema,
      response: { 200: saveResponseSchema },
    },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await saveEntity({
        redis,
        prisma,
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.delete("/reels/:reelId/save", {
    schema: {
      params: reelIdParamsSchema,
      response: { 200: saveResponseSchema },
    },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await unsaveEntity({
        redis,
        prisma,
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.get("/reels/saved", {
    schema: { response: { 200: listWithStatsResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "reel",
        collection: "saved",
        userId,
      });

      // Fetch engagement stats for all saved reels
      let statsMap: Record<string, { likes: number; views: number }> = {};
      if (ids.length > 0) {
        statsMap = await getStatsBatch({
          redis,
          entityType: "reel",
          entityIds: ids,
        });
      }

      const items = ids.map((id) => ({
        id,
        likes: statsMap[id]?.likes ?? 0,
        views: statsMap[id]?.views ?? 0,
      }));

      return listWithStatsResponseSchema.parse({ items });
    },
  });

  fastify.post("/reels/:reelId/view", {
    schema: {
      params: reelIdParamsSchema,
      response: { 200: viewResponseSchema },
    },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const result = await addView({
        redis,
        prisma,
        entityType: "reel",
        entityId: reelId,
      });
      return viewResponseSchema.parse(result);
    },
  });

  fastify.get("/reels/:reelId/stats", {
    schema: { params: reelIdParamsSchema, response: { 200: statsSchema } },
    handler: async (request) => {
      const { reelId } = reelIdParamsSchema.parse(request.params);
      const stats = await getStats({
        redis,
        entityType: "reel",
        entityId: reelId,
      });
      return statsSchema.parse(stats);
    },
  });

  fastify.post("/reels/stats", {
    schema: {
      body: statsBatchRequestSchema,
      response: { 200: statsBatchResponseSchema },
    },
    handler: async (request) => {
      const body = statsBatchRequestSchema.parse(request.body);
      const stats = await getStatsBatch({
        redis,
        entityType: "reel",
        entityIds: body.ids,
      });
      return statsBatchResponseSchema.parse({ stats });
    },
  });

  // Series
  fastify.post("/series/:seriesId/like", {
    schema: {
      params: seriesIdParamsSchema,
      response: { 200: likeResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await likeEntity({
        redis,
        prisma,
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.delete("/series/:seriesId/like", {
    schema: {
      params: seriesIdParamsSchema,
      response: { 200: likeResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await unlikeEntity({
        redis,
        prisma,
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.get("/series/liked", {
    schema: { response: { 200: listWithStatsResponseSchema } },
    handler: async (request) => {
      try {
        const userId = requireUserId(request.headers as Record<string, unknown>);
        const ids = await listUserEntities({
          redis,
          entityType: "series",
          collection: "liked",
          userId,
        });

        // Fetch engagement stats for all liked series
        let statsMap: Record<string, { likes: number; views: number }> = {};
        if (ids.length > 0) {
          statsMap = await getStatsBatch({
            redis,
            entityType: "series",
            entityIds: ids,
          });
        }

        const items = ids.map((id) => ({
          id,
          likes: statsMap[id]?.likes ?? 0,
          views: statsMap[id]?.views ?? 0,
        }));

        return listWithStatsResponseSchema.parse({ items });
      } catch (err) {
        request.log.error({ err }, "Error in /series/liked");
        throw err;
      }
    },
  });

  fastify.post("/series/:seriesId/save", {
    schema: {
      params: seriesIdParamsSchema,
      response: { 200: saveResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await saveEntity({
        redis,
        prisma,
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.delete("/series/:seriesId/save", {
    schema: {
      params: seriesIdParamsSchema,
      response: { 200: saveResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const result = await unsaveEntity({
        redis,
        prisma,
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.get("/series/saved", {
    schema: { response: { 200: listWithStatsResponseSchema } },
    handler: async (request) => {
      try {
        const userId = requireUserId(request.headers as Record<string, unknown>);
        const ids = await listUserEntities({
          redis,
          entityType: "series",
          collection: "saved",
          userId,
        });

        // Fetch engagement stats for all saved series
        let statsMap: Record<string, { likes: number; views: number }> = {};
        if (ids.length > 0) {
          statsMap = await getStatsBatch({
            redis,
            entityType: "series",
            entityIds: ids,
          });
        }

        const items = ids.map((id) => ({
          id,
          likes: statsMap[id]?.likes ?? 0,
          views: statsMap[id]?.views ?? 0,
        }));

        return listWithStatsResponseSchema.parse({ items });
      } catch (err) {
        request.log.error({ err }, "Error in /series/saved");
        throw err;
      }
    },
  });

  fastify.post("/series/:seriesId/view", {
    schema: {
      params: seriesIdParamsSchema,
      response: { 200: viewResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const result = await addView({
        redis,
        prisma,
        entityType: "series",
        entityId: seriesId,
      });
      return viewResponseSchema.parse(result);
    },
  });

  fastify.get("/series/:seriesId/stats", {
    schema: { params: seriesIdParamsSchema, response: { 200: statsSchema } },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const stats = await getStats({
        redis,
        entityType: "series",
        entityId: seriesId,
      });
      return statsSchema.parse(stats);
    },
  });

  fastify.post("/series/stats", {
    schema: {
      body: statsBatchRequestSchema,
      response: { 200: statsBatchResponseSchema },
    },
    handler: async (request) => {
      const body = statsBatchRequestSchema.parse(request.body);
      const stats = await getStatsBatch({
        redis,
        entityType: "series",
        entityIds: body.ids,
      });
      return statsBatchResponseSchema.parse({ stats });
    },
  });

  fastify.post("/progress", {
    schema: {
      body: continueWatchUpsertSchema,
    },
    handler: async (request) => {
      try {
        const body = continueWatchUpsertSchema.parse(request.body);
        const entry = await upsertViewProgress({
          redis,
          prisma,
          userId: body.userId,
          episodeId: body.episodeId,
          progressSeconds: body.watchedDuration,
          durationSeconds: body.totalDuration,
        });

        request.log.info(
          { userId: body.userId, episodeId: body.episodeId },
          "Recorded continue watch progress"
        );

        return {
          episode_id: body.episodeId,
          watched_duration: entry.progressSeconds,
          total_duration: entry.durationSeconds,
          last_watched_at: new Date().toISOString(),
          is_completed: entry.completedAt !== null,
        };
      } catch (err) {
        request.log.error({ err }, "Error in /progress");
        throw err;
      }
    },
  });

  fastify.post("/progress/query", {
    schema: {
      body: continueWatchQuerySchema,
    },
    handler: async (request) => {
      const body = continueWatchQuerySchema.parse(request.body);
      const episodeIds = body.limit
        ? body.episodeIds.slice(0, body.limit)
        : body.episodeIds;
      const entries = await getViewProgressBatch({
        prisma,
        userId: body.userId,
        episodeIds,
      });
      const payload = {
        entries: entries.map((entry: any) => ({
          episode_id: entry.episodeId,
          watched_duration: entry.progressSeconds, // DB has progressSeconds
          total_duration: entry.durationSeconds, // DB has durationSeconds
          last_watched_at: entry.updatedAt.toISOString(), // Use updatedAt as last watched
          is_completed: entry.completedAt !== null,
        })),
      };
      return continueWatchResponseSchema.parse(payload);
    },
  });
  fastify.post("/series/:seriesId/reviews", {
    schema: {
      params: seriesIdParamsSchema,
      body: addReviewBodySchema,
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const body = addReviewBodySchema.parse(request.body);
      const userId = requireUserId(request.headers as Record<string, unknown>);

      const result = await addReview({
        redis,
        entityType: "series",
        entityId: seriesId,
        userId,
        userName: body.user_name,
        rating: body.rating,
        title: body.title,
        comment: body.comment,
      });

      return { review_id: result.reviewId };
    },
  });

  fastify.get("/series/:seriesId/reviews", {
    schema: {
      params: seriesIdParamsSchema,
      querystring: getReviewsQuerySchema,
      response: { 200: reviewsResponseSchema },
    },
    handler: async (request) => {
      const { seriesId } = seriesIdParamsSchema.parse(request.params);
      const query = getReviewsQuerySchema.parse(request.query);

      const result = await getReviews({
        redis,
        entityType: "series",
        entityId: seriesId,
        limit: query.limit,
        cursor: query.cursor,
      });

      return {
        summary: {
          average_rating: result.averageRating,
          total_reviews: result.totalReviews,
        },
        user_reviews: result.reviews as any[], // Casting because schemas might differ slightly in property names (camel vs snake) - checked below
        next_cursor: result.nextCursor,
      };
    },
  });
}
