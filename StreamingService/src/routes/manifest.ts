import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  manifestParamsSchema,
  manifestQuerySchema,
  manifestResponseSchema,
} from "../schemas/streaming";
import { getServiceDependencies } from "../services/dependencies";
import {
  ManifestService,
  ManifestAccessError,
} from "../services/manifest-service";

const deps = getServiceDependencies();
const manifestService = new ManifestService(
  deps.repository,
  deps.cdnSigner,
  deps.authClient,
  deps.alertingService,
  deps.metrics,
  deps.config
);

export default fp(async function manifestRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { contentId: string } }>("/:contentId/manifest", {
    schema: {
      params: manifestParamsSchema,
      querystring: manifestQuerySchema,
      response: {
        200: manifestResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const params = manifestParamsSchema.parse(request.params);
      const query = manifestQuerySchema.parse(request.query);
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        throw reply.server.httpErrors.unauthorized(
          "Missing Authorization header"
        );
      }
      const token = authHeader.replace(/Bearer\s+/i, "").trim();
      try {
        const manifest = await manifestService.getManifest({
          contentId: params.contentId,
          quality: query.quality,
          device: query.device,
          viewerGeo: query.geo,
          sessionId: query.session,
          viewerToken: token,
          correlationId: request.id,
        });

        reply.header("Cache-Control", manifest.policy.cacheControl);
        reply.header("CDN-Cache-Control", "private, max-age=30");
        reply.header("Edge-Control", "cache-maxage=30");

        return manifest;
      } catch (error) {
        if (error instanceof ManifestAccessError) {
          reply.status(error.statusCode);
          return { message: error.message };
        }
        throw error;
      }
    },
  });
});
