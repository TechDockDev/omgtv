import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../../config";
import { getRedis } from "../../lib/redis";
import { TrendingService } from "../../services/trending-service";
import {
  DataQualityMonitor,
  CatalogConsistencyError,
} from "../../services/data-quality-monitor";
import { ViewerCatalogService } from "../../services/viewer-catalog-service";
import { CatalogRepository } from "../../repositories/catalog-repository";
import {
  MobileAppService,
  type MobileRequestContext,
} from "../../services/mobile-app-service";
import {
  mobileHomeEnvelopeSchema,
  mobileHomeQuerySchema,
  mobileReelsEnvelopeSchema,
  mobileReelsQuerySchema,
  mobileSeriesEnvelopeSchema,
  mobileSeriesParamsSchema,
  mobileTagsEnvelopeSchema,
  mobileTagsQuerySchema,
} from "../../schemas/mobile-app";
import { EngagementClient } from "../../clients/engagement-client";
import { SubscriptionClient } from "../../clients/subscription-client";

function buildRequestContext(request: FastifyRequest): MobileRequestContext {
  const userId =
    typeof request.headers["x-user-id"] === "string"
      ? request.headers["x-user-id"].trim()
      : undefined;
  const userType =
    typeof request.headers["x-user-type"] === "string"
      ? request.headers["x-user-type"].trim()
      : undefined;
  const languageId =
    typeof request.headers["x-user-language-id"] === "string"
      ? request.headers["x-user-language-id"].trim()
      : undefined;
  const rolesHeader = request.headers["x-user-roles"];
  const roles = Array.isArray(rolesHeader)
    ? rolesHeader
    : typeof rolesHeader === "string"
      ? rolesHeader
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
      : [];

  return {
    userId: userId && userId.length > 0 ? userId : undefined,
    userType,
    languageId,
    roles,
  };
}

export default async function mobileAppRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const redis = getRedis();
  const trendingService = new TrendingService(redis, {
    trendingKey: config.TRENDING_SORTED_SET_KEY,
    ratingsKey: config.RATINGS_HASH_KEY,
  });
  const qualityMonitor = new DataQualityMonitor();
  const viewerCatalog = new ViewerCatalogService({
    feedCacheTtlSeconds: config.FEED_CACHE_TTL_SECONDS,
    seriesCacheTtlSeconds: config.SERIES_CACHE_TTL_SECONDS,
    relatedCacheTtlSeconds: config.RELATED_CACHE_TTL_SECONDS,
    redis,
    trending: trendingService,
    qualityMonitor,
  });
  const repository = new CatalogRepository();
  const engagementClient = new EngagementClient({
    baseUrl: config.ENGAGEMENT_SERVICE_URL,
    timeoutMs: config.SERVICE_REQUEST_TIMEOUT_MS,
  });
  const subscriptionClient = new SubscriptionClient({
    baseUrl: config.SUBSCRIPTION_SERVICE_URL,
    timeoutMs: config.SERVICE_REQUEST_TIMEOUT_MS,
  });
  const mobileApp = new MobileAppService({
    viewerCatalog,
    repository,
    config: {
      homeFeedLimit: config.MOBILE_HOME_FEED_LIMIT,
      carouselLimit: config.MOBILE_HOME_CAROUSEL_LIMIT,
      continueWatchLimit: config.MOBILE_HOME_CONTINUE_WATCH_LIMIT,
      sectionItemLimit: config.MOBILE_HOME_SECTION_ITEM_LIMIT,
      reelsPageSize: config.MOBILE_REELS_PAGE_SIZE,
      defaultPlanPurchased: config.MOBILE_DEFAULT_PLAN_PURCHASED,
      defaultGuestCanWatch: config.MOBILE_DEFAULT_CAN_GUEST_WATCH,
      streamingType: config.MOBILE_STREAMING_TYPE,
    },
    engagementClient,
    subscriptionClient,
  });

  const verifyRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    await fastify.verifyServiceRequest(request, reply);
  };

  fastify.get("/tags", {
    config: { metricsId: "/mobile/tags" },
    preHandler: verifyRequest,
    schema: {
      querystring: mobileTagsQuerySchema,
      response: {
        200: mobileTagsEnvelopeSchema,
      },
    },
    handler: async (request) => {
      const query = mobileTagsQuerySchema.parse(request.query);
      const data = await mobileApp.listTags(query);
      return {
        success: true,
        statusCode: 200,
        userMessage: "Tags loaded successfully",
        developerMessage: "All navigation tags fetched",
        data,
      } as const;
    },
  });

  fastify.get("/home", {
    config: { metricsId: "/mobile/home" },
    preHandler: verifyRequest,
    schema: {
      querystring: mobileHomeQuerySchema,
      response: {
        200: mobileHomeEnvelopeSchema,
      },
    },
    handler: async (request, reply) => {
      const query = mobileHomeQuerySchema.parse(request.query);
      const context = buildRequestContext(request);
      try {
        const result = await mobileApp.getHomeExperience(query, {
          context,
          logger: request.log,
        });
        reply.header(
          "cache-control",
          `public, max-age=${config.FEED_CACHE_TTL_SECONDS}`
        );
        reply.header("x-cache", result.fromCache ? "hit" : "miss");
        return {
          success: true,
          statusCode: 200,
          userMessage: "Content loaded successfully",
          developerMessage: `Home screen data fetched with tag: ${query.tag ?? "home"
            }`,
          data: result.data,
        } as const;
      } catch (error) {
        if (error instanceof CatalogConsistencyError) {
          request.log.error({ err: error }, "Mobile home experience failed");
          throw fastify.httpErrors.internalServerError(
            `Catalog data quality issue: ${error.message}`
          );
        }
        throw error;
      }
    },
  });

  fastify.get("/series/:seriesId", {
    config: { metricsId: "/mobile/series/:seriesId" },
    preHandler: verifyRequest,
    schema: {
      params: mobileSeriesParamsSchema,
      response: {
        200: mobileSeriesEnvelopeSchema,
      },
    },
    handler: async (request) => {
      const params = mobileSeriesParamsSchema.parse(request.params);
      const context = buildRequestContext(request);
      try {
        const detail = await mobileApp.getSeriesDetail(params, {
          context,
          logger: request.log,
        });
        if (!detail) {
          throw fastify.httpErrors.notFound("Series not found");
        }
        return {
          success: true,
          statusCode: 200,
          userMessage: "Content loaded successfully",
          developerMessage: "Series detail fetched",
          data: detail,
        } as const;
      } catch (error) {
        if (error instanceof CatalogConsistencyError) {
          request.log.error({ err: error }, "Series data quality issue");
          throw fastify.httpErrors.internalServerError(
            "Catalog data quality issue"
          );
        }
        throw error;
      }
    },
  });

  fastify.get("/reels", {
    config: { metricsId: "/mobile/reels" },
    preHandler: verifyRequest,
    schema: {
      querystring: mobileReelsQuerySchema,
      response: {
        200: mobileReelsEnvelopeSchema,
      },
    },
    handler: async (request) => {
      const query = mobileReelsQuerySchema.parse(request.query);
      const context = buildRequestContext(request);
      const data = await mobileApp.listReels(query, {
        context,
        logger: request.log,
      });
      return {
        success: true,
        statusCode: 200,
        userMessage: "Reel loaded successfully",
        developerMessage: "Mobile reels payload generated",
        data,
      } as const;
    },
  });
}
