import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  adminCarouselBodySchema,
  adminCarouselSuccessResponseSchema,
  contentParamsSchema,
  contentSuccessResponseSchema,
  type AdminCarouselBody,
  type AdminCarouselResponse,
  type ContentResponse,
} from "../schemas/content.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  getVideoMetadata,
  setAdminCarouselEntries,
} from "../proxy/content.proxy";
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
  },
  { name: "content-routes" }
);
