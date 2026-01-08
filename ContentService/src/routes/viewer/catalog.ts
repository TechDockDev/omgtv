import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../../config";
import {
  feedQuerySchema,
  seriesDetailParamsSchema,
  relatedSeriesParamsSchema,
  relatedSeriesQuerySchema,
  categoryListQuerySchema,
} from "../../schemas/viewer-catalog";
import { ViewerCatalogService } from "../../services/viewer-catalog-service";
import {
  CatalogConsistencyError,
  DataQualityMonitor,
} from "../../services/data-quality-monitor";
import { getRedis } from "../../lib/redis";
import { TrendingService } from "../../services/trending-service";

export default async function viewerCatalogRoutes(fastify: FastifyInstance) {
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

  const verifyRequest = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    await fastify.verifyServiceRequest(request, reply);
  };

  fastify.get("/feed", {
    config: { metricsId: "/catalog/feed" },
    preHandler: verifyRequest,
    schema: {
      querystring: feedQuerySchema,
    },
    handler: async (request, reply) => {
      const query = feedQuerySchema.parse(request.query);
      try {
        const result = await viewerCatalog.getFeed(query);
        reply.header(
          "cache-control",
          `public, max-age=${config.FEED_CACHE_TTL_SECONDS}`
        );
        reply.header("x-cache", result.fromCache ? "hit" : "miss");
        return {
          items: result.items,
          nextCursor: result.nextCursor,
        };
      } catch (error) {
        if (error instanceof CatalogConsistencyError) {
          request.log.error(
            {
              err: error,
              contentId: error.issue.attributes.episodeId,
              issue: error.issue.kind,
            },
            "Catalog data quality failure on viewer feed"
          );
          const failure = fastify.httpErrors.internalServerError(
            "Catalog data quality issue"
          );
          (failure as { issue?: string }).issue = error.issue.kind;
          throw failure;
        }
        throw error;
      }
    },
  });

  fastify.get("/series/:slug", {
    config: { metricsId: "/catalog/series/:slug" },
    preHandler: verifyRequest,
    schema: {
      params: seriesDetailParamsSchema,
    },
    handler: async (request, reply) => {
      const params = seriesDetailParamsSchema.parse(request.params);
      try {
        const result = await viewerCatalog.getSeriesDetail({
          slug: params.slug,
        });
        if (!result) {
          throw fastify.httpErrors.notFound("Series not found");
        }
        reply.header(
          "cache-control",
          `public, max-age=${config.SERIES_CACHE_TTL_SECONDS}`
        );
        reply.header("x-cache", result.fromCache ? "hit" : "miss");
        return {
          series: result.series,
          seasons: result.seasons,
          standaloneEpisodes: result.standaloneEpisodes,
        };
      } catch (error) {
        if (error instanceof CatalogConsistencyError) {
          request.log.error(
            {
              err: error,
              contentId: error.issue.attributes.episodeId,
              issue: error.issue.kind,
            },
            "Catalog data quality failure on series detail"
          );
          const failure = fastify.httpErrors.internalServerError(
            "Catalog data quality issue"
          );
          (failure as { issue?: string }).issue = error.issue.kind;
          throw failure;
        }
        throw error;
      }
    },
  });

  fastify.get("/series/:slug/related", {
    config: { metricsId: "/catalog/series/:slug/related" },
    preHandler: verifyRequest,
    schema: {
      params: relatedSeriesParamsSchema,
      querystring: relatedSeriesQuerySchema,
    },
    handler: async (request, reply) => {
      const params = relatedSeriesParamsSchema.parse(request.params);
      const query = relatedSeriesQuerySchema.parse(request.query);
      try {
        const result = await viewerCatalog.getRelatedSeries({
          slug: params.slug,
          limit: query.limit,
        });
        if (!result) {
          throw fastify.httpErrors.notFound("Series not found");
        }
        reply.header(
          "cache-control",
          `public, max-age=${config.RELATED_CACHE_TTL_SECONDS}`
        );
        reply.header("x-cache", result.fromCache ? "hit" : "miss");
        return {
          items: result.items,
        };
      } catch (error) {
        if (error instanceof CatalogConsistencyError) {
          request.log.error(
            {
              err: error,
              contentId: error.issue.attributes.episodeId,
              issue: error.issue.kind,
            },
            "Catalog data quality failure on related series"
          );
          const failure = fastify.httpErrors.internalServerError(
            "Catalog data quality issue"
          );
          (failure as { issue?: string }).issue = error.issue.kind;
          throw failure;
        }
        throw error;
      }
    },
  });

  fastify.get("/categories", {
    config: { metricsId: "/catalog/categories" },
    preHandler: verifyRequest,
    schema: {
      querystring: categoryListQuerySchema,
    },
    handler: async (request, reply) => {
      const query = categoryListQuerySchema.parse(request.query);
      const result = await viewerCatalog.listCategories(query);
      reply.header(
        "cache-control",
        `public, max-age=${config.FEED_CACHE_TTL_SECONDS}`
      );
      return result;
    },
  });
}
