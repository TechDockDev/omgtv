import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createUploadUrlBodySchema,
  createUploadUrlSuccessResponseSchema,
  uploadQuotaSuccessResponseSchema,
  uploadStatusSuccessResponseSchema,
  type CreateUploadUrlBody,
  type CreateUploadUrlResponse,
  type UploadQuotaResponse,
  type UploadStatusResponse,
} from "../schemas/upload.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  createUploadUrl,
  getUploadQuota,
  getUploadStatus,
} from "../proxy/upload.proxy";

const uploadIdParamsSchema = z.object({
  uploadId: z.string().uuid(),
});

export default fp(
  async function uploadRoutes(fastify: FastifyInstance) {
    fastify.route<{
      Body: CreateUploadUrlBody;
      Reply: CreateUploadUrlResponse;
    }>({
      method: "POST",
      url: "/sign",
      schema: {
        body: createUploadUrlBodySchema,
        response: {
          200: createUploadUrlSuccessResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: false },
        rateLimitPolicy: "admin",
        security: { bodyLimit: 16 * 1024 },
      },
      preHandler: [fastify.authorize(["admin"])],
      async handler(request, reply) {
        const body = createUploadUrlBodySchema.parse(request.body);
        const result = await createUploadUrl(
          body,
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
        request.log.info(
          {
            adminId: request.user?.id,
            assetType: body.assetType,
            sizeBytes: body.sizeBytes,
          },
          "Generated admin upload URL"
        );
        return reply.code(200).send(result);
      },
    });

    fastify.route<{
      Params: { uploadId: string };
      Reply: UploadStatusResponse;
    }>({
      method: "GET",
      url: "/:uploadId/status",
      schema: {
        params: uploadIdParamsSchema,
        response: {
          200: uploadStatusSuccessResponseSchema,
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
      async handler(request) {
        const params = uploadIdParamsSchema.parse(request.params);
        const status = await getUploadStatus(
          params.uploadId,
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
        request.log.info(
          { uploadId: params.uploadId, adminId: request.user?.id },
          "Fetched upload status"
        );
        return status;
      },
    });

    fastify.route<{
      Reply: UploadQuotaResponse;
    }>({
      method: "GET",
      url: "/quota",
      schema: {
        response: {
          200: uploadQuotaSuccessResponseSchema,
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
      async handler(request) {
        const quota = await getUploadQuota(
          request.correlationId,
          request.user!,
          request.telemetrySpan
        );
        request.log.info(
          { adminId: request.user?.id, quota },
          "Fetched admin upload quota"
        );
        return quota;
      },
    });
  },
  { name: "upload-routes" }
);
