import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config";
import { registerEpisodeAssetSchema } from "../schemas/episode-assets";
import {
  CatalogService,
  CatalogServiceError,
} from "../services/catalog-service";
import {
  engagementMetricsEventSchema,
  mediaProcessedEventSchema,
  mediaUploadedEventSchema,
} from "../schemas/events";
import { ViewerCatalogService } from "../services/viewer-catalog-service";
import {
  batchContentRequestSchema,
  batchContentResponseSchema,
} from "../schemas/viewer-catalog";
import { getRedis } from "../lib/redis";
import { TrendingService } from "../services/trending-service";
import { RedisCatalogEventsPublisher } from "../services/catalog-events";
import { DataQualityMonitor } from "../services/data-quality-monitor";

export default async function internalRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const redis = getRedis();
  const eventsPublisher = new RedisCatalogEventsPublisher(
    redis,
    config.CATALOG_EVENT_STREAM_KEY
  );
  const trendingService = new TrendingService(redis, {
    trendingKey: config.TRENDING_SORTED_SET_KEY,
    ratingsKey: config.RATINGS_HASH_KEY,
  });
  const catalog = new CatalogService({
    defaultOwnerId: config.DEFAULT_OWNER_ID,
    eventsPublisher,
  });
  const viewerCatalog = new ViewerCatalogService({
    feedCacheTtlSeconds: config.FEED_CACHE_TTL_SECONDS,
    seriesCacheTtlSeconds: config.SERIES_CACHE_TTL_SECONDS,
    relatedCacheTtlSeconds: config.RELATED_CACHE_TTL_SECONDS,
    redis,
    trending: trendingService,
    qualityMonitor: new DataQualityMonitor(),
  });
  const systemActorId = "SYSTEM";

  fastify.get("/videos/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const metadata = await viewerCatalog.getEpisodeMetadata(params.id);
      if (!metadata) {
        throw fastify.httpErrors.notFound("Episode not found");
      }
      return metadata;
    },
  });

  fastify.get("/catalog/categories/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const category = await catalog.getCategoryById(params.id);
        return category;
      } catch (error) {
        if (
          error instanceof CatalogServiceError &&
          error.code === "NOT_FOUND"
        ) {
          throw fastify.httpErrors.notFound("Category not found");
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to fetch category"
        );
        throw fastify.httpErrors.internalServerError(
          "Unable to fetch category"
        );
      }
    },
  });

  fastify.get("/catalog/media/:id", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
    handler: async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const metadata = await viewerCatalog.getEpisodeMetadata(params.id);
      if (!metadata) {
        throw fastify.httpErrors.notFound("Media not found");
      }
      return metadata;
    },
  });

  fastify.post<{
    Params: { id: string };
  }>("/catalog/episodes/:id/assets", {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: registerEpisodeAssetSchema,
    },
    handler: async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = registerEpisodeAssetSchema.parse(request.body);
      try {
        const result = await catalog.registerEpisodeAsset(systemActorId, {
          episodeId: params.id,
          ...body,
        });
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            throw fastify.httpErrors.notFound(error.message);
          }
          if (error.code === "FAILED_PRECONDITION") {
            throw fastify.httpErrors.preconditionFailed(error.message);
          }
        }
        request.log.error(
          { err: error, contentId: params.id },
          "Failed to register episode asset via internal route"
        );
        throw fastify.httpErrors.internalServerError(
          "Unable to register episode asset"
        );
      }
    },
  });

  fastify.post("/events/media-uploaded", {
    schema: {
      body: mediaUploadedEventSchema,
    },
    handler: async (request, reply) => {
      const body = mediaUploadedEventSchema.parse(request.body);
      try {
        await catalog.handleMediaUploaded({
          uploadId: body.uploadId,
          contentId: body.contentId ?? undefined,
          contentType: body.contentClassification ?? undefined,
          filename: body.fileName ?? undefined,
          assetType: body.assetType ?? undefined,
          storageUrl: body.storageUrl ?? undefined,
          cdnUrl: body.cdnUrl ?? undefined,
          sizeBytes: body.sizeBytes ?? undefined,
        });
        return reply.status(202).send({ accepted: true });
      } catch (error) {
        request.log.error({ err: error, uploadId: body.uploadId }, "Failed to handle media uploaded event");
        throw fastify.httpErrors.internalServerError("Unable to process media uploaded event");
      }
    }
  });

  fastify.post("/events/media-processed", {
    schema: {
      body: mediaProcessedEventSchema,
    },
    handler: async (request, reply) => {
      const body = mediaProcessedEventSchema.parse(request.body);
      try {
        await catalog.registerEpisodeAsset(systemActorId, {
          episodeId: body.episodeId,
          status: body.status,
          sourceUploadId: body.sourceUploadId ?? null,
          streamingAssetId: body.streamingAssetId ?? null,
          manifestUrl: body.manifestUrl ?? null,
          defaultThumbnailUrl: body.defaultThumbnailUrl ?? null,
          variants: body.variants,
        });
        return reply.status(202).send({ accepted: true });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "NOT_FOUND") {
            throw fastify.httpErrors.notFound(error.message);
          }
          if (error.code === "FAILED_PRECONDITION") {
            throw fastify.httpErrors.preconditionFailed(error.message);
          }
        }
        request.log.error(
          { err: error, contentId: body.episodeId },
          "Failed to process media event"
        );
        throw fastify.httpErrors.internalServerError(
          "Unable to apply media processed event"
        );
      }
    },
  });

  fastify.post("/events/engagement/metrics", {
    schema: {
      body: engagementMetricsEventSchema,
    },
    handler: async (request, reply) => {
      const body = engagementMetricsEventSchema.parse(request.body);
      try {
        await trendingService.applyMetrics(body.metrics);
        return reply.status(202).send({ accepted: true });
      } catch (error) {
        request.log.error({ err: error }, "Failed to apply engagement metrics");
        throw fastify.httpErrors.internalServerError(
          "Unable to persist engagement metrics"
        );
      }
    },
  });

  fastify.post("/catalog/batch", {
    schema: {
      body: batchContentRequestSchema,
      response: { 200: batchContentResponseSchema },
    },
    handler: async (request) => {
      const { ids, type } = batchContentRequestSchema.parse(request.body);
      let items: any[] = [];
      if (type === "reel") {
        items = await viewerCatalog.getReelsBatch(ids);
      } else {
        items = await viewerCatalog.getSeriesBatch(ids);
      }
      return batchContentResponseSchema.parse({ items });
    },
  });


}
