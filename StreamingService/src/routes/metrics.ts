import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { getServiceDependencies } from "../services/dependencies";

const deps = getServiceDependencies();

export default fp(async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get("/metrics", {
    handler: async (request, reply) => {
      const token = request.headers.authorization
        ?.replace(/Bearer\s+/i, "")
        .trim();
      if (
        deps.config.METRICS_ACCESS_TOKEN &&
        token !== deps.config.METRICS_ACCESS_TOKEN
      ) {
        throw reply.server.httpErrors.unauthorized("Invalid metrics token");
      }
      await deps.monitoring.collectAndPublish();
      reply.header("content-type", "text/plain; version=0.0.4");
      return deps.metrics.render();
    },
  });

  fastify.get("/internal/qos", {
    preHandler: fastify.verifyServiceRequest,
    handler: async () => {
      const failed = await deps.repository.listFailed(20);
      return {
        failed,
        timestamp: new Date().toISOString(),
      };
    },
  });
});
