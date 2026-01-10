import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  engagementEventBodySchema,
  continueWatchQuerySchema,
  continueWatchResponseSchema,
  continueWatchUpsertSchema,
  likeResponseSchema,
  listResponseSchema,
  reelIdParamsSchema,
  saveResponseSchema,
  seriesIdParamsSchema,
  statsBatchRequestSchema,
  statsBatchResponseSchema,
  statsSchema,
  viewResponseSchema,
  type EngagementEventMetrics,
} from "../schemas/engagement";
import {
  addReviewBodySchema,
  getReviewsQuerySchema,
  reviewsResponseSchema,
} from "../schemas/review";
import {
  applyEngagementEvent,
  getProgressEntries,
  upsertProgress,
} from "../services/engagement";
import { getRedisOptional } from "../lib/redis";
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
} from "../services/collection-engagement";

function requireUserId(headers: Record<string, unknown>) {
  const value = headers["x-user-id"];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error("UNAUTHORIZED: Missing x-user-id");
}

export default fp(async function internalRoutes(fastify: FastifyInstance) {
  const redis = getRedisOptional();

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
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.get("/reels/liked", {
    schema: { response: { 200: listResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "reel",
        collection: "liked",
        userId,
      });
      return listResponseSchema.parse({ ids });
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
        entityType: "reel",
        entityId: reelId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.get("/reels/saved", {
    schema: { response: { 200: listResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "reel",
        collection: "saved",
        userId,
      });
      return listResponseSchema.parse({ ids });
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
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return likeResponseSchema.parse(result);
    },
  });

  fastify.get("/series/liked", {
    schema: { response: { 200: listResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "series",
        collection: "liked",
        userId,
      });
      return listResponseSchema.parse({ ids });
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
        entityType: "series",
        entityId: seriesId,
        userId,
      });
      return saveResponseSchema.parse(result);
    },
  });

  fastify.get("/series/saved", {
    schema: { response: { 200: listResponseSchema } },
    handler: async (request) => {
      const userId = requireUserId(request.headers as Record<string, unknown>);
      const ids = await listUserEntities({
        redis,
        entityType: "series",
        collection: "saved",
        userId,
      });
      return listResponseSchema.parse({ ids });
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
      const body = continueWatchUpsertSchema.parse(request.body);
      const entry = upsertProgress({
        userId: body.userId,
        episodeId: body.episodeId,
        watchedDuration: body.watchedDuration,
        totalDuration: body.totalDuration,
        lastWatchedAt: body.lastWatchedAt ?? undefined,
        isCompleted: body.isCompleted,
      });

      request.log.info(
        { userId: body.userId, episodeId: body.episodeId },
        "Recorded continue watch progress"
      );

      return {
        episode_id: entry.episodeId,
        watched_duration: entry.watchedDuration,
        total_duration: entry.totalDuration,
        last_watched_at: entry.lastWatchedAt,
        is_completed: entry.isCompleted,
      };
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
      const entries = getProgressEntries(body.userId, episodeIds);
      const payload = {
        entries: entries.map((entry) => ({
          episode_id: entry.episodeId,
          watched_duration: entry.watchedDuration,
          total_duration: entry.totalDuration,
          last_watched_at: entry.lastWatchedAt,
          is_completed: entry.isCompleted,
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
});
