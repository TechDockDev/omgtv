import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  channelMetadataSchema,
  registerStreamRequestSchema,
} from "../schemas/streaming";
import { getServiceDependencies } from "../services/dependencies";
import { StreamAdminService } from "../services/admin-service";

const deps = getServiceDependencies();
const adminService = new StreamAdminService(
  deps.channelProvisioner,
  deps.repository,
  deps.cdnClient,
  deps.omeClient,
  deps.notificationPublisher,
  deps.alertingService
);

export default fp(async function adminRoutes(fastify: FastifyInstance) {
  fastify.post("/register", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      body: registerStreamRequestSchema,
      response: {
        202: channelMetadataSchema,
      },
    },
    handler: async (request, reply) => {
      const body = registerStreamRequestSchema.parse(request.body);
      const metadata = await adminService.register(body);
      reply.code(202);
      return metadata;
    },
  });

  fastify.get("/:contentId", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      params: channelMetadataSchema.pick({ contentId: true }),
      response: {
        200: channelMetadataSchema,
      },
    },
    handler: async (request, reply) => {
      const { contentId } = request.params as { contentId: string };
      const metadata = await adminService.get(contentId);
      if (!metadata) {
        throw reply.notFound("Stream not found");
      }
      return metadata;
    },
  });

  fastify.delete("/:contentId", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      params: channelMetadataSchema.pick({ contentId: true }),
      response: {
        204: { type: "null" },
      },
    },
    handler: async (request, reply) => {
      const { contentId } = request.params as { contentId: string };
      await adminService.retire(contentId);
      reply.code(204);
    },
  });

  fastify.post("/:contentId/purge", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      params: channelMetadataSchema.pick({ contentId: true }),
      response: {
        202: { type: "object", properties: { status: { type: "string" } } },
      },
    },
    handler: async (request) => {
      const { contentId } = request.params as { contentId: string };
      await adminService.purge(contentId);
      return { status: "purge-requested" };
    },
  });

  fastify.post("/:contentId/rotate-ingest", {
    preHandler: fastify.verifyServiceRequest,
    schema: {
      params: channelMetadataSchema.pick({ contentId: true }),
      response: {
        202: { type: "object", properties: { status: { type: "string" } } },
      },
    },
    handler: async (request) => {
      const { contentId } = request.params as { contentId: string };
      await adminService.rotateIngest(contentId);
      return { status: "rotation-requested" };
    },
  });
});
