import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getServiceDependencies } from "../services/dependencies";
import { ProbeService } from "../services/probe-service";

const deps = getServiceDependencies();
const probeService = new ProbeService(
  deps.repository,
  deps.cdnSigner,
  deps.alertingService,
  deps.metrics,
  deps.cdnClient,
  deps.analytics,
  deps.config
);

const probeRequestSchema = z.object({
  contentId: z.string().uuid(),
});

export default fp(async function probeRoutes(fastify: FastifyInstance) {
  fastify.post("/manifest", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      body: probeRequestSchema,
    },
    handler: async (request) => {
      const body = probeRequestSchema.parse(request.body);
      const results = await probeService.runManifestProbes(body.contentId);
      return { results };
    },
  });
});
