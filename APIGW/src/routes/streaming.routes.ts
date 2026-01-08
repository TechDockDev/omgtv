import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  manifestParamsSchema,
  manifestQuerySchema,
  manifestSuccessResponseSchema,
  registerStreamRequestSchema,
  registerStreamResponseSchema,
  channelMetadataResponseSchema,
  type ManifestParams,
  type ManifestQuery,
  type ManifestResponse,
} from "../schemas/streaming.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  getStreamManifest,
  registerStream,
  getStreamMetadata,
  retireStream,
  purgeStream,
  rotateIngest,
} from "../proxy/streaming.proxy";

export default fp(
  async function streamingRoutes(fastify: FastifyInstance) {
    fastify.route<{
      Params: ManifestParams;
      Querystring: ManifestQuery;
      Reply: ManifestResponse;
    }>({
      method: "GET",
      url: "/:contentId/manifest",
      schema: {
        params: manifestParamsSchema,
        querystring: manifestQuerySchema,
        response: {
          200: manifestSuccessResponseSchema,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "authenticated",
      },
      preHandler: [fastify.authorize(["user", "admin"])],
      async handler(request) {
        const params = manifestParamsSchema.parse(request.params);
        const query = manifestQuerySchema.parse(request.query);

        const manifest = await getStreamManifest({
          contentId: params.contentId,
          user: request.user!,
          correlationId: request.correlationId,
          query,
          span: request.telemetrySpan,
          viewerToken: request.headers.authorization,
        });

        request.log.info(
          { contentId: params.contentId, cdn: manifest.cdn },
          "Issued manifest"
        );

        return manifest;
      },
    });

    fastify.post(
      "/admin/register-stream",
      {
        schema: {
          body: registerStreamRequestSchema,
          response: {
            202: registerStreamResponseSchema,
          },
        },
        config: { auth: { public: false }, rateLimitPolicy: "admin" },
        preHandler: [fastify.authorize(["admin"])],
      },
      async (request, reply) => {
        const body = registerStreamRequestSchema.parse(request.body);
        const metadata = await registerStream(
          body,
          request.correlationId,
          request.telemetrySpan
        );
        reply.code(202);
        return metadata;
      }
    );

    fastify.get(
      "/admin/:contentId",
      {
        schema: {
          params: manifestParamsSchema,
          response: {
            200: channelMetadataResponseSchema,
          },
        },
        config: { auth: { public: false }, rateLimitPolicy: "admin" },
        preHandler: [fastify.authorize(["admin"])],
      },
      async (request) => {
        const params = manifestParamsSchema.parse(request.params);
        const metadata = await getStreamMetadata(
          params.contentId,
          request.correlationId
        );
        return metadata;
      }
    );

    fastify.delete(
      "/admin/:contentId",
      {
        schema: {
          params: manifestParamsSchema,
          response: {
            204: { type: "null" },
          },
        },
        config: { auth: { public: false }, rateLimitPolicy: "admin" },
        preHandler: [fastify.authorize(["admin"])],
      },
      async (request, reply) => {
        const params = manifestParamsSchema.parse(request.params);
        await retireStream(params.contentId, request.correlationId);
        reply.code(204);
      }
    );

    fastify.post(
      "/admin/:contentId/purge",
      {
        schema: {
          params: manifestParamsSchema,
        },
        config: { auth: { public: false }, rateLimitPolicy: "admin" },
        preHandler: [fastify.authorize(["admin"])],
      },
      async (request) => {
        const params = manifestParamsSchema.parse(request.params);
        await purgeStream(params.contentId, request.correlationId);
        return { status: "purge-requested" };
      }
    );

    fastify.post(
      "/admin/:contentId/rotate-ingest",
      {
        schema: {
          params: manifestParamsSchema,
        },
        config: { auth: { public: false }, rateLimitPolicy: "admin" },
        preHandler: [fastify.authorize(["admin"])],
      },
      async (request) => {
        const params = manifestParamsSchema.parse(request.params);
        await rotateIngest(params.contentId, request.correlationId);
        return { status: "rotation-requested" };
      }
    );
  },
  { name: "streaming-routes" }
);
