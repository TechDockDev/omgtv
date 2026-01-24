import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import type { GatewayUser } from "../types";
import {
  contentResponseSchema,
  adminCarouselBodySchema,
  adminCarouselResponseSchema,
  type AdminCarouselBody,
  type AdminCarouselResponse,
  type ContentResponse,
  batchContentResponseSchema,
  type BatchContentResponse,
} from "../schemas/content.schema";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";

interface GetVideoMetadataArgs {
  videoId: string;
  correlationId: string;
  user?: GatewayUser;
  span?: Span;
}

interface SetCarouselArgs {
  body: AdminCarouselBody;
  correlationId: string;
  user: GatewayUser;
  span?: Span;
}

interface GetBatchContentArgs {
  ids: string[];
  type: "reel" | "series";
  correlationId: string;
  user: GatewayUser;
  span?: Span;
}

export async function getVideoMetadata({
  videoId,
  correlationId,
  user,
  span,
}: GetVideoMetadataArgs): Promise<ContentResponse> {
  const baseUrl = resolveServiceUrl("content");
  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "content",
      baseUrl,
      path: `/internal/videos/${videoId}`,
      method: "GET",
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:content:getVideoMetadata",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404) {
        throw createHttpError(404, "Video not found", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Failed to retrieve video metadata",
        error.cause
      );
    }
    throw error;
  }

  const parsed = contentResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from content service");
  }

  return parsed.data;
}

export async function setAdminCarouselEntries({
  body,
  correlationId,
  user,
  span,
}: SetCarouselArgs): Promise<AdminCarouselResponse> {
  const baseUrl = resolveServiceUrl("content");
  adminCarouselBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "content",
      baseUrl,
      path: "/api/v1/content/admin/catalog/carousel",
      method: "POST",
      body,
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:content:setCarousel",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404) {
        throw createHttpError(404, "Referenced content not found", error.cause);
      }
      if (error.statusCode === 412) {
        throw createHttpError(
          412,
          "Carousel prerequisites not met",
          error.cause
        );
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Failed to update carousel entries",
        error.cause
      );
    }
    throw error;
  }

  const parsed = adminCarouselResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from content service");
  }

  return parsed.data;
}

export async function getBatchContent({
  ids,
  type,
  correlationId,
  user,
  span,
}: GetBatchContentArgs): Promise<BatchContentResponse> {
  const baseUrl = resolveServiceUrl("content");
  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "content",
      baseUrl,
      path: "/internal/catalog/batch",
      method: "POST",
      body: { ids, type },
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:content:getBatchContent",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Failed to retrieve batch content",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  const parsed = batchContentResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from content service");
  }

  return parsed.data;
}

export async function processMediaAsset({
  mediaId,
  correlationId,
  user,
  span,
}: {
  mediaId: string;
  correlationId: string;
  user: GatewayUser;
  span?: Span;
}): Promise<any> {
  const baseUrl = resolveServiceUrl("content");
  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "content",
      baseUrl,
      path: `/api/v1/content/admin/media/${mediaId}/process`,
      method: "POST",
      correlationId,
      user,
      headers: {
        "x-admin-id": user.id,
      },
      body: {}, // Empty body as required by the endpoint
      parentSpan: span,
      spanName: "proxy:content:processMediaAsset",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404) {
        throw createHttpError(404, "Media asset not found", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Failed to trigger media process",
        error.cause
      );
    }
    throw error;
  }

  return payload;
}

export interface ListMediaAssetsArgs {
  status?: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  type?: "EPISODE" | "REEL";
  unassigned?: boolean;
  limit?: number;
  cursor?: string;
  correlationId: string;
  user: GatewayUser;
  span?: Span;
}

export async function listMediaAssets({
  status,
  type,
  unassigned,
  limit,
  cursor,
  correlationId,
  user,
  span,
}: ListMediaAssetsArgs): Promise<any> {
  const baseUrl = resolveServiceUrl("content");

  const query: Record<string, any> = {};
  if (status) query.status = status;
  if (type) query.type = type;
  if (unassigned !== undefined) query.unassigned = unassigned;
  if (limit) query.limit = limit;
  if (cursor) query.cursor = cursor;

  const queryString = new URLSearchParams(query).toString();
  const path = `/api/v1/content/admin/media${queryString ? `?${queryString}` : ""}`;

  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "content",
      baseUrl,
      path,
      method: "GET",
      correlationId,
      user,
      headers: {
        "x-admin-id": user.id,
      },
      parentSpan: span,
      spanName: "proxy:content:listMediaAssets",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Failed to list media assets",
        error.cause
      );
    }
    throw error;
  }

  return payload;
}
