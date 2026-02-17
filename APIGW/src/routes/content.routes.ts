import fp from "fastify-plugin";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  adminCarouselBodySchema,
  adminCarouselSuccessResponseSchema,
  contentParamsSchema,
  contentSuccessResponseSchema,
  type AdminCarouselBody,
  type AdminCarouselResponse,
  type ContentResponse,
  adminTopTenBodySchema,
  adminTopTenResponseSchema,
  type AdminTopTenBody,
  type AdminTopTenResponse,
} from "../schemas/content.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  getVideoMetadata,
  setAdminCarouselEntries,
  processMediaAsset,
  listMediaAssets,
  getTopTenSeries,
  updateTopTenSeries,
  getAdminCarouselEntries,
  reorderAdminCarouselEntries,
  addAdminCarouselSeries,
  removeAdminCarouselSeries,
  getSeriesReviews,
  uploadMedia,
  uploadImage,
  uploadThumbnail,
} from "../proxy/content.proxy";
import {
  mediaProcessSuccessResponseSchema,
  mediaAssetListSuccessResponseSchema,
  adminCarouselActionSuccessResponseSchema,
  type AdminCarouselActionResponse,
  uploadMediaBodySchema,
  uploadMediaResponseSchema,
  uploadImageBodySchema,
  uploadImageResponseSchema,
  uploadThumbnailResponseSchema,
  type UploadMediaBody,
  type UploadMediaResponse,
  type UploadImageBody,
  type UploadImageResponse,
  type UploadThumbnailResponse,
} from "../schemas/content.schema";
import { getCachedJson, setCachedJson } from "../utils/cache";
import { getContentCacheTtlSeconds } from "../config";

const CONTENT_CACHE_PREFIX = "content:metadata";

export default fp(
  async function contentRoutes(fastify: FastifyInstance) {
    fastify.route<{
      Params: { id: string };
      Reply: ContentResponse;
    }>({
      method: "GET",
      url: "/:id",
      schema: {
        params: contentParamsSchema,
        response: {
          200: contentSuccessResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: true },
      },
      async handler(request, reply) {
        const params = contentParamsSchema.parse(request.params);
        const cacheKey = `${CONTENT_CACHE_PREFIX}:${params.id}`;
        const ttlSeconds = getContentCacheTtlSeconds();

        let cached: ContentResponse | null = null;
        try {
          cached = await getCachedJson<ContentResponse>(
            fastify.redis,
            cacheKey
          );
        } catch (error) {
          request.log.warn(
            { err: error, cacheKey },
            "Failed to read content cache"
          );
        }

        if (cached) {
          reply.header("x-cache", "hit");
          return cached;
        }

        const metadata = await getVideoMetadata({
          videoId: params.id,
          correlationId: request.correlationId,
          user: request.user,
          span: request.telemetrySpan,
        });

        try {
          await setCachedJson(fastify.redis, cacheKey, metadata, ttlSeconds);
        } catch (error) {
          request.log.warn(
            { err: error, cacheKey },
            "Failed to store content cache"
          );
        }

        request.log.info({ videoId: params.id }, "Served video metadata");
        reply.header("x-cache", "miss");
        return metadata;
      },
    });

    fastify.route<{
      Body: AdminCarouselBody;
      Reply: AdminCarouselResponse;
    }>({
      method: "POST",
      url: "/admin/catalog/carousel",
      schema: {
        body: adminCarouselBodySchema,
        response: {
          201: adminCarouselSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          412: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = adminCarouselBodySchema.parse(request.body);
        const result = await setAdminCarouselEntries({
          body,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          {
            adminId: request.user?.id,
            selections: body.items.length,
          },
          "Updated mobile carousel selections"
        );
        return reply.code(201).send(result);
      },
    });

    // New Carousel APIs
    fastify.route<{
      Reply: AdminCarouselResponse;
    }>({
      method: "GET",
      url: "/admin/catalog/carousel",
      schema: {
        response: {
          200: adminCarouselSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const result = await getAdminCarouselEntries({
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result);
      },
    });

    fastify.route<{
      Body: AdminCarouselBody;
      Reply: AdminCarouselResponse;
    }>({
      method: "POST",
      url: "/admin/catalog/carousel/reorder",
      schema: {
        // reorder uses same body as set
        body: adminCarouselBodySchema,
        response: {
          200: adminCarouselSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          412: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = adminCarouselBodySchema.parse(request.body);
        const result = await reorderAdminCarouselEntries({
          body,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result);
      },
    });

    fastify.route<{
      Params: { seriesId: string };
      Reply: AdminCarouselActionResponse;
    }>({
      method: "POST",
      url: "/admin/catalog/carousel/series/:seriesId",
      schema: {
        params: z.object({ seriesId: z.string().uuid() }),
        response: {
          200: adminCarouselActionSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          412: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const { seriesId } = request.params;
        const result = await addAdminCarouselSeries({
          seriesId,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result as AdminCarouselActionResponse);
      },
    });

    fastify.route<{
      Params: { seriesId: string };
      Reply: AdminCarouselActionResponse;
    }>({
      method: "DELETE",
      url: "/admin/catalog/carousel/series/:seriesId",
      schema: {
        params: z.object({ seriesId: z.string().uuid() }),
        response: {
          200: adminCarouselActionSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const { seriesId } = request.params;
        const result = await removeAdminCarouselSeries({
          seriesId,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result as AdminCarouselActionResponse);
      },
    });

    fastify.route<{
      Params: { id: string };
    }>({
      method: "POST",
      url: "/admin/media/:id/process",
      schema: {
        params: contentParamsSchema,
        response: {
          200: mediaProcessSuccessResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const params = contentParamsSchema.parse(request.params);
        const result = await processMediaAsset({
          mediaId: params.id,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          {
            adminId: request.user?.id,
            mediaId: params.id,
          },
          "Triggered manual transcoding"
        );
        return reply.code(200).send(result);
      },
    });

    fastify.route<{
      Body: AdminTopTenBody;
      Reply: AdminTopTenResponse;
    }>({
      method: "POST",
      url: "/admin/catalog/top-10",
      schema: {
        body: adminTopTenBodySchema,
        response: {
          200: adminTopTenResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          412: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = adminTopTenBodySchema.parse(request.body);
        const result = await updateTopTenSeries({
          body,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          { adminId: request.user?.id },
          "Updated top 10 series"
        );
        return reply.send(result);
      },
    });

    fastify.route<{
      Reply: AdminTopTenResponse;
    }>({
      method: "GET",
      url: "/admin/catalog/top-10",
      schema: {
        response: {
          200: adminTopTenResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const result = await getTopTenSeries({
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result);
      },
    });

    fastify.route<{
      Params: { seriesId: string };
      Querystring: { limit?: number; cursor?: string };
    }>({
      method: "GET",
      url: "/admin/catalog/series/:seriesId/reviews",
      schema: {
        params: z.object({ seriesId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          cursor: z.string().optional(),
        }),
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const { seriesId } = request.params;
        const { limit, cursor } = request.query;
        const result = await getSeriesReviews({
          seriesId,
          limit,
          cursor,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        return reply.send(result);
      },
    });
    fastify.route<{
      Params: { id: string };
      Reply: UploadThumbnailResponse;
    }>({
      method: "POST",
      url: "/admin/media/:id/thumbnail",
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: uploadThumbnailResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const { id } = request.params;
        const result = await uploadThumbnail({
          mediaId: id,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          { adminId: request.user?.id, mediaId: id },
          "Initiated thumbnail upload"
        );
        return reply.send(result as UploadThumbnailResponse);
      },
    });

    fastify.route<{
      Body: UploadMediaBody;
      Reply: UploadMediaResponse;
    }>({
      method: "POST",
      url: "/admin/media/upload",
      schema: {
        body: uploadMediaBodySchema,
        response: {
          200: uploadMediaResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = uploadMediaBodySchema.parse(request.body);
        const result = await uploadMedia({
          body,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          { adminId: request.user?.id, type: body.type },
          "Initiated media upload"
        );
        return reply.send(result as UploadMediaResponse);
      },
    });

    fastify.route<{
      Body: UploadImageBody;
      Reply: UploadImageResponse;
    }>({
      method: "POST",
      url: "/admin/catalog/images/upload",
      schema: {
        body: uploadImageBodySchema,
        response: {
          200: uploadImageResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = uploadImageBodySchema.parse(request.body);
        const result = await uploadImage({
          body,
          correlationId: request.correlationId,
          user: request.user!,
          span: request.telemetrySpan,
        });
        request.log.info(
          { adminId: request.user?.id },
          "Initiated image upload"
        );
        return reply.send(result as UploadImageResponse);
      },
    });

  },
  { name: "content-routes" }
);
