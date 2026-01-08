import { resolveServiceUrl } from "../config";
import type { GatewayUser } from "../types";
import type { Span } from "@opentelemetry/api";
import type {
  ManifestQuery,
  ManifestResponse,
  RegisterStreamRequest,
} from "../schemas/streaming.schema";
import {
  manifestResponseSchema,
  streamMetadataSchema,
} from "../schemas/streaming.schema";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";

interface GetManifestArgs {
  contentId: string;
  user: GatewayUser;
  correlationId: string;
  query: ManifestQuery;
  viewerToken?: string;
  span?: Span;
}

export async function getStreamManifest({
  contentId,
  user,
  correlationId,
  query,
  span,
  viewerToken,
}: GetManifestArgs): Promise<ManifestResponse> {
  const baseUrl = resolveServiceUrl("streaming");
  let payload: unknown;
  try {
    const response = await performServiceRequest({
      serviceName: "streaming",
      baseUrl,
      path: `/v1/streams/${contentId}/manifest`,
      method: "GET",
      correlationId,
      user,
      query: {
        quality: query.quality,
        device: query.device,
        geo: query.geo,
        session: query.session,
      },
      headers: viewerToken ? { authorization: viewerToken } : undefined,
      parentSpan: span,
      spanName: "proxy:streaming:getManifest",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 404) {
        throw createHttpError(404, "Stream not found", error.cause);
      }
      if (error.statusCode === 403) {
        throw createHttpError(403, "Playback not permitted", error.cause);
      }
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to retrieve manifest",
        error.cause
      );
    }
    throw error;
  }

  const parsed = manifestResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid manifest response from streaming service");
  }

  return parsed.data;
}

export async function registerStream(
  body: RegisterStreamRequest,
  correlationId: string,
  span?: Span
) {
  const response = await performServiceRequest({
    serviceName: "streaming",
    baseUrl: resolveServiceUrl("streaming"),
    path: `/v1/admin/streams/register`,
    method: "POST",
    correlationId,
    body,
    spanName: "proxy:streaming:register",
    parentSpan: span,
  });
  const parsed = streamMetadataSchema.safeParse(response.payload);
  if (!parsed.success) {
    throw new Error("Invalid register response from streaming service");
  }
  return parsed.data;
}

export async function getStreamMetadata(
  contentId: string,
  correlationId: string
) {
  const response = await performServiceRequest({
    serviceName: "streaming",
    baseUrl: resolveServiceUrl("streaming"),
    path: `/v1/admin/streams/${contentId}`,
    method: "GET",
    correlationId,
  });
  const parsed = streamMetadataSchema.safeParse(response.payload);
  if (!parsed.success) {
    throw new Error("Invalid metadata response from streaming service");
  }
  return parsed.data;
}

export async function retireStream(contentId: string, correlationId: string) {
  await performServiceRequest({
    serviceName: "streaming",
    baseUrl: resolveServiceUrl("streaming"),
    path: `/v1/admin/streams/${contentId}`,
    method: "DELETE",
    correlationId,
  });
}

export async function purgeStream(contentId: string, correlationId: string) {
  await performServiceRequest({
    serviceName: "streaming",
    baseUrl: resolveServiceUrl("streaming"),
    path: `/v1/admin/streams/${contentId}/purge`,
    method: "POST",
    correlationId,
  });
}

export async function rotateIngest(contentId: string, correlationId: string) {
  await performServiceRequest({
    serviceName: "streaming",
    baseUrl: resolveServiceUrl("streaming"),
    path: `/v1/admin/streams/${contentId}/rotate-ingest`,
    method: "POST",
    correlationId,
  });
}
