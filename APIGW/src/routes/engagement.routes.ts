import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
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
} from "../proxy/engagement.proxy";

export default fp(
  async function engagementRoutes(fastify: FastifyInstance) {
    const authenticatedConfig = {
      auth: { public: false },
      rateLimitPolicy: "authenticated" as const,
      security: { bodyLimit: 8 * 1024 },
    };

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

    // Batch endpoint for processing multiple engagement actions
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
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        const body = batchActionRequestSchema.parse(request.body);
        const response = await processBatchActions(
          body,
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
        request.log.info(
          { processed: response.processed, failed: response.failed },
          "Batch engagement actions forwarded"
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        return reelSavedList(
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        return reelLikedList(
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        return seriesSavedList(
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        return seriesLikedList(
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
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
      preHandler: [fastify.authorize(["user", "admin"])],
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
      preHandler: [fastify.authorize(["user", "admin"])],
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

    // Batch interactions endpoint (Removed duplicate)
    // The main batch endpoint is defined above using processBatchActions

  },
  { name: "engagement-routes" }
);
