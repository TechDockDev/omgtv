import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";
import {
  createUploadUrlBodySchema,
  createUploadUrlResponseSchema,
  uploadStatusResponseSchema,
  uploadQuotaResponseSchema,
  type CreateUploadUrlBody,
  type CreateUploadUrlResponse,
  type UploadStatusResponse,
  type UploadQuotaResponse,
} from "../schemas/upload.schema";
import { userContextSchema } from "../schemas/user.schema";
import type { GatewayUser } from "../types";

interface VerifiedAdminContext {
  userId: string;
}

const ADMIN_ROLE_NAME = "ADMIN";

async function verifyAdminUser(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<VerifiedAdminContext> {
  if (user.userType !== "ADMIN") {
    throw createHttpError(403, "Admin user required");
  }

  const baseUrl = resolveServiceUrl("user");
  let payload: unknown;

  try {
    const response = await performServiceRequest({
      serviceName: "user",
      baseUrl,
      path: `/api/v1/user/admin/users/${user.id}/context`,
      method: "GET",
      correlationId,
      user,
      timeoutMs: 5_000,
      parentSpan: span,
      spanName: "proxy:user:adminContext",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404 || error.statusCode === 403) {
        throw createHttpError(403, "Admin verification failed", error.cause);
      }
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to verify admin user",
        error.cause
      );
    }
    throw error;
  }

  const context = userContextSchema.parse(payload);
  if (context.userId !== user.id) {
    throw createHttpError(403, "Admin verification mismatch");
  }

  const hasActiveAdminAssignment = context.assignments.some(
    (assignment) =>
      assignment.active &&
      assignment.role.name.toUpperCase() === ADMIN_ROLE_NAME
  );

  if (!hasActiveAdminAssignment) {
    throw createHttpError(403, "User lacks active admin privileges");
  }

  return {
    userId: context.userId,
  };
}

function buildAdminHeaders(context: VerifiedAdminContext) {
  return {
    "x-pocketlol-admin-id": context.userId,
    "x-pocketlol-user-type": "ADMIN",
  } as const;
}

export async function createUploadUrl(
  body: CreateUploadUrlBody,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<CreateUploadUrlResponse> {
  const baseUrl = resolveServiceUrl("upload");
  const validatedBody = createUploadUrlBodySchema.parse(body);
  const adminContext = await verifyAdminUser(correlationId, user, span);

  let payload: unknown;
  try {
    const response = await performServiceRequest<CreateUploadUrlResponse>({
      serviceName: "upload",
      baseUrl,
      path: "/v1/admin/uploads/sign",
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      timeoutMs: 10_000,
      parentSpan: span,
      spanName: "proxy:upload:createUploadUrl",
      headers: buildAdminHeaders(adminContext),
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 403) {
        throw createHttpError(403, "Upload not permitted", error.cause);
      }
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to create upload URL",
        error.cause
      );
    }
    throw error;
  }

  const parsed = createUploadUrlResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from upload service");
  }

  return parsed.data;
}

export async function getUploadStatus(
  uploadId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UploadStatusResponse> {
  const baseUrl = resolveServiceUrl("upload");
  const adminContext = await verifyAdminUser(correlationId, user, span);

  let payload: unknown;
  try {
    const response = await performServiceRequest<UploadStatusResponse>({
      serviceName: "upload",
      baseUrl,
      path: `/v1/admin/uploads/${uploadId}/status`,
      method: "GET",
      correlationId,
      user,
      timeoutMs: 5_000,
      parentSpan: span,
      spanName: "proxy:upload:getStatus",
      headers: buildAdminHeaders(adminContext),
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404) {
        throw createHttpError(404, "Upload not found", error.cause);
      }
      if (error.statusCode === 403) {
        throw createHttpError(403, "Upload not permitted", error.cause);
      }
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to fetch upload status",
        error.cause
      );
    }
    throw error;
  }

  const parsed = uploadStatusResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from upload service");
  }

  return parsed.data;
}

export async function getUploadQuota(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UploadQuotaResponse> {
  const baseUrl = resolveServiceUrl("upload");
  const adminContext = await verifyAdminUser(correlationId, user, span);

  let payload: unknown;
  try {
    const response = await performServiceRequest<UploadQuotaResponse>({
      serviceName: "upload",
      baseUrl,
      path: "/v1/admin/uploads/quota",
      method: "GET",
      correlationId,
      user,
      timeoutMs: 5_000,
      parentSpan: span,
      spanName: "proxy:upload:getQuota",
      headers: buildAdminHeaders(adminContext),
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 403) {
        throw createHttpError(403, "Upload quota unavailable", error.cause);
      }
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to fetch upload quota",
        error.cause
      );
    }
    throw error;
  }

  const parsed = uploadQuotaResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from upload service");
  }

  return parsed.data;
}
