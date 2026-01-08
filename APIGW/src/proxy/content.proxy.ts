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
