// fp import removed
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  engagementEventBodySchema,
  engagementEventSuccessResponseSchema,
  engagementIdParamsSchema,
  engagementLikeSuccessResponseSchema,
  engagementListSuccessResponseSchema,
  engagementSaveSuccessResponseSchema,
  engagementStatsSuccessResponseSchema,
  engagementViewSuccessResponseSchema,
  batchActionRequestSchema,
  batchActionSuccessResponseSchema,
  type EngagementEventBody,
  type EngagementEventData,
  type EngagementIdParams,
  type EngagementLikeData,
  type EngagementListData,
  type EngagementSaveData,
  type EngagementStatsData,
  type EngagementViewData,
  type BatchActionRequest,
  type BatchActionResponseData,
  addReviewBodySchema,
  addReviewResponseSchema,
  addReviewSuccessResponseSchema,
  type AddReviewBody,
  type AddReviewResponse,
} from "../schemas/engagement.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  publishEngagementEvent,
  reelAddView,
  reelLikedList,
  reelLike,
  reelSave,
  reelSavedList,
  reelStats,
  reelUnlike,
  reelUnsave,
  seriesAddView,
  seriesLikedList,
  seriesLike,
  seriesSave,
  seriesSavedList,
  seriesStats,
  seriesUnlike,
  seriesUnsave,
  processBatchActions,
  saveProgress,
  getProgress,
  addReviewProxy,
  getUserContentStatsProxy,
  getGeneralDashboardStatsProxy,
} from "../proxy/engagement.proxy";
import { getBatchContent } from "../proxy/content.proxy";
import {
  saveProgressBodySchema,
  progressResponseSchema,
  getProgressParamsSchema,
  userContentAnalyticsSuccessResponseSchema,
  type SaveProgressBody,
  type ProgressResponse,
} from "../schemas/engagement.schema";

export default async function engagementRoutes(fastify: FastifyInstance) {
  const authenticatedConfig = {
    auth: { public: false },
    rateLimitPolicy: "authenticated" as const,
    security: { bodyLimit: 8 * 1024 },
  };

  // Admin: General Dashboard Analytics
  fastify.route<{
    Querystring: { startDate?: string; endDate?: string; granularity?: string };
  }>({
    method: "GET",
    url: "/analytics/dashboard",
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        granularity: z.enum(["daily", "monthly", "yearly"]).optional(),
      }),
      response: {
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: false },
      rateLimitPolicy: "authenticated" as const,
    },
    preHandler: [fastify.authorize(["admin"])],
    async handler(request) {
      const query = request.query as { startDate?: string; endDate?: string; granularity?: string };
      return getGeneralDashboardStatsProxy(
        query,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // Admin: User Content Analytics
  fastify.route<{
    Params: { userId: string };
  }>({
    method: "GET",
    url: "/analytics/users/:userId/content",
    schema: {
      params: z.object({ userId: z.string().min(1) }),
      response: {
        200: userContentAnalyticsSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: false },
      rateLimitPolicy: "authenticated" as const,
    },
    preHandler: [fastify.authorize(["admin"])],
    async handler(request) {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
      const { limit, offset } = z.object({
        limit: z.coerce.number().min(1).max(100).optional(),
        offset: z.coerce.number().min(0).optional(),
      }).parse(request.query);

      return getUserContentStatsProxy(
        userId,
        { limit, offset },
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Body: EngagementEventBody;
    Reply: EngagementEventData;
  }>({
    method: "POST",
    url: "/like",
    schema: {
      body: engagementEventBodySchema,
      response: {
        200: engagementEventSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin"])],
    async handler(request) {
      const body = engagementEventBodySchema.parse({
        ...request.body,
        action: request.body?.action ?? "like",
      });
      const response = await publishEngagementEvent(
        body,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      request.log.info(
        { videoId: body.videoId, action: body.action },
        "Engagement event forwarded"
      );
      return response;
    },
  });



  // Reels
  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementSaveData;
  }>({
    method: "POST",
    url: "/reels/:id/save",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementSaveSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelSave(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementSaveData;
  }>({
    method: "DELETE",
    url: "/reels/:id/save",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementSaveSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelUnsave(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Reply: EngagementListData;
  }>({
    method: "GET",
    url: "/reels/saved",
    schema: {
      response: {
        200: engagementListSuccessResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const items = await reelSavedList(
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      if (items.length === 0) {
        return { items: [] };
      }

      const ids = items.map((i) => i.id);
      const contentResponse = await getBatchContent({
        ids,
        type: "reel",
        correlationId: request.correlationId,
        user: request.user!,
        span: request.telemetrySpan,
      });

      const statsMap = new Map(items.map((i) => [i.id, i]));
      const mergedItems = contentResponse.items.map((item: any) => {
        const stats = statsMap.get(item.id);
        return {
          ...item,
          engagement: {
            ...item.engagement,
            likes: stats?.likes ?? 0,
            views: stats?.views ?? 0,
          },
        };
      });

      return { items: mergedItems };
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementLikeData;
  }>({
    method: "POST",
    url: "/reels/:id/like",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementLikeSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelLike(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementLikeData;
  }>({
    method: "DELETE",
    url: "/reels/:id/like",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementLikeSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelUnlike(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Reply: EngagementListData;
  }>({
    method: "GET",
    url: "/reels/liked",
    schema: {
      response: {
        200: engagementListSuccessResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const items = await reelLikedList(
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );

      if (items.length === 0) {
        return { items: [] };
      }

      const ids = items.map((i) => i.id);
      const contentResponse = await getBatchContent({
        ids,
        type: "reel",
        correlationId: request.correlationId,
        user: request.user!,
        span: request.telemetrySpan,
      });

      const statsMap = new Map(items.map((i) => [i.id, i]));
      const mergedItems = contentResponse.items.map((item: any) => {
        const stats = statsMap.get(item.id);
        return {
          ...item,
          engagement: {
            ...item.engagement,
            likes: stats?.likes ?? 0,
            views: stats?.views ?? 0,
          },
        };
      });

      return { items: mergedItems };
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementViewData;
  }>({
    method: "POST",
    url: "/reels/:id/view",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementViewSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelAddView(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementStatsData;
  }>({
    method: "GET",
    url: "/reels/:id/stats",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementStatsSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return reelStats(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // Series
  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementSaveData;
  }>({
    method: "POST",
    url: "/series/:id/save",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementSaveSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesSave(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementSaveData;
  }>({
    method: "DELETE",
    url: "/series/:id/save",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementSaveSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesUnsave(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Reply: EngagementListData;
  }>({
    method: "GET",
    url: "/series/saved",
    schema: {
      response: {
        200: engagementListSuccessResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const items = await seriesSavedList(
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      if (items.length === 0) {
        return { items: [] };
      }

      const ids = items.map((i) => i.id);
      const contentResponse = await getBatchContent({
        ids,
        type: "series",
        correlationId: request.correlationId,
        user: request.user!,
        span: request.telemetrySpan,
      });

      const statsMap = new Map(items.map((i) => [i.id, i]));
      const mergedItems = contentResponse.items.map((item: any) => {
        const stats = statsMap.get(item.id);
        return {
          ...item,
          engagement: {
            ...item.engagement,
            likes: stats?.likes ?? 0,
            views: stats?.views ?? 0,
          },
        };
      });

      return { items: mergedItems };
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementLikeData;
  }>({
    method: "POST",
    url: "/series/:id/like",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementLikeSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesLike(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementLikeData;
  }>({
    method: "DELETE",
    url: "/series/:id/like",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementLikeSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesUnlike(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Reply: EngagementListData;
  }>({
    method: "GET",
    url: "/series/liked",
    schema: {
      response: {
        200: engagementListSuccessResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const items = await seriesLikedList(
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      if (items.length === 0) {
        return { items: [] };
      }

      const ids = items.map((i) => i.id);
      const contentResponse = await getBatchContent({
        ids,
        type: "series",
        correlationId: request.correlationId,
        user: request.user!,
        span: request.telemetrySpan,
      });

      const statsMap = new Map(items.map((i) => [i.id, i]));
      const mergedItems = contentResponse.items.map((item: any) => {
        const stats = statsMap.get(item.id);
        return {
          ...item,
          engagement: {
            ...item.engagement,
            likes: stats?.likes ?? 0,
            views: stats?.views ?? 0,
          },
        };
      });

      return { items: mergedItems };
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementViewData;
  }>({
    method: "POST",
    url: "/series/:id/view",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementViewSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesAddView(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: EngagementIdParams;
    Reply: EngagementStatsData;
  }>({
    method: "GET",
    url: "/series/:id/stats",
    schema: {
      params: engagementIdParamsSchema,
      response: {
        200: engagementStatsSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      return seriesStats(
        id,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // Batch interactions endpoint
  fastify.route<{
    Body: BatchActionRequest;
    Reply: BatchActionResponseData;
  }>({
    method: "POST",
    url: "/batch",
    schema: {
      body: batchActionRequestSchema,
      response: {
        200: batchActionSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const body = batchActionRequestSchema.parse(request.body);
      return processBatchActions(
        body,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // View Progress
  fastify.route<{
    Body: SaveProgressBody;
    Reply: ProgressResponse;
  }>({
    method: "POST",
    url: "/progress",
    schema: {
      body: saveProgressBodySchema,
      response: {
        // 200: progressResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const body = saveProgressBodySchema.parse(request.body);
      return saveProgress(
        body,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  fastify.route<{
    Params: { episodeId: string };
    Reply: ProgressResponse;
  }>({
    method: "GET",
    url: "/progress/:episodeId",
    schema: {
      params: getProgressParamsSchema,
      response: {
        // 200: progressResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { episodeId } = getProgressParamsSchema.parse(request.params);
      return getProgress(
        episodeId,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // Reviews
  fastify.route<{
    Params: { id: string };
    Body: AddReviewBody;
    Reply: AddReviewResponse;
  }>({
    method: "POST",
    url: "/client/reviews/:id",
    schema: {
      params: engagementIdParamsSchema,
      body: addReviewBodySchema,
      response: {
        200: addReviewSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: authenticatedConfig,
    preHandler: [fastify.authorize(["user", "admin", "guest"])],
    async handler(request) {
      const { id } = engagementIdParamsSchema.parse(request.params);
      const body = addReviewBodySchema.parse(request.body);
      return addReviewProxy(
        id,
        body,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
    },
  });

  // Logging to confirm registration
  fastify.log.info("Engagement Routes registered successfully");
}
