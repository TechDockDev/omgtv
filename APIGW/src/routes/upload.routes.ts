// import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createUploadUrlBodySchema,
  createUploadUrlSuccessResponseSchema,
  uploadQuotaSuccessResponseSchema,
  uploadStatusSuccessResponseSchema,
  retryUploadSuccessResponseSchema,
  type CreateUploadUrlBody,
  type CreateUploadUrlResponse,
  type UploadQuotaResponse,
  type UploadStatusResponse,
  type RetryUploadSuccessResponse,
} from "../schemas/upload.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import { wrapSuccess } from "../utils/envelope";
import {
  createUploadUrl,
  getUploadQuota,
  getUploadStatus,
  retryUploadProcessing,
  validateUpload,
  type ValidationCallbackBody,
} from "../proxy/upload.proxy";

const uploadIdParamsSchema = z.object({
  uploadId: z.string().uuid(),
});

// fp removal
export default async function uploadRoutes(fastify: FastifyInstance) {
  fastify.route<{
    Body: CreateUploadUrlBody;
    Reply: CreateUploadUrlResponse;
  }>({
    method: "POST",
    url: "/admin/uploads/sign",
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
    url: "/admin/uploads/:uploadId/status",
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
    Params: { uploadId: string };
    Reply: RetryUploadSuccessResponse;
  }>({
    method: "POST",
    url: "/admin/uploads/:uploadId/retry",
    schema: {
      params: uploadIdParamsSchema,
      response: {
        200: retryUploadSuccessResponseSchema,
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
      const result = await retryUploadProcessing(
        params.uploadId,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      request.log.info(
        { uploadId: params.uploadId, adminId: request.user?.id },
        "Retried upload processing"
      );
      return wrapSuccess(result);
    },
  });

  fastify.route<{
    Reply: UploadQuotaResponse;
  }>({
    method: "GET",
    url: "/admin/uploads/quota",
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

  // Validation callback route
  const validationBodySchema = z.object({
    status: z.enum(["success", "failed"]),
    durationSeconds: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    checksum: z.string().optional(),
    failureReason: z.string().optional(),
  });

  fastify.route<{
    Params: { uploadId: string };
    Body: ValidationCallbackBody;
  }>({
    method: "POST",
    url: "/admin/uploads/:uploadId/validation",
    schema: {
      params: uploadIdParamsSchema,
      body: validationBodySchema,
      response: {
        200: z.any(),
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
      const body = validationBodySchema.parse(request.body);
      const result = await validateUpload(
        params.uploadId,
        body as ValidationCallbackBody,
        request.correlationId,
        request.user!,
        request.telemetrySpan
      );
      request.log.info(
        { uploadId: params.uploadId, adminId: request.user?.id, status: body.status },
        "Validated upload"
      );
      return result;
    },
  });
}
