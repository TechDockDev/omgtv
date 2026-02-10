import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";
import {
  engagementEventBodySchema,
  engagementEventDataSchema,
  type EngagementEventBody,
  type EngagementEventData,
  engagementLikeDataSchema,
  engagementListDataSchema,
  engagementSaveDataSchema,
  engagementStatsDataSchema,
  engagementViewDataSchema,
  type EngagementLikeData,
  type EngagementListData,
  type EngagementSaveData,
  type EngagementStatsData,
  type EngagementViewData,
  batchActionRequestSchema,
  batchActionResponseDataSchema,
  type BatchActionRequest,
  type BatchActionResponseData,
  saveProgressBodySchema,
  progressResponseSchema,
  type SaveProgressBody,
  type ProgressResponse,
  addReviewBodySchema,
  addReviewResponseSchema,
  type AddReviewBody,
  type AddReviewResponse,
} from "../schemas/engagement.schema";
import { z } from "zod";


const upstreamListSchema = z.object({
  ids: z.array(z.string().uuid()),
});

const upstreamListItemSchema = z.object({
  id: z.string().uuid(),
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
});

const upstreamListWithStatsSchema = z.object({
  items: z.array(upstreamListItemSchema),
});

export type UpstreamListItem = z.infer<typeof upstreamListItemSchema>;
import type { GatewayUser } from "../types";

export async function publishEngagementEvent(
  body: EngagementEventBody,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementEventData> {
  const baseUrl = resolveServiceUrl("engagement");
  const validatedBody = engagementEventBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<EngagementEventData>({
      serviceName: "engagement",
      baseUrl,
      path: "/internal/events",
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:engagement:publishEvent",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to publish engagement event",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  const parsed = engagementEventDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }

  return parsed.data;
}

async function requestEngagement<T>(options: {
  path: string;
  method: "GET" | "POST" | "DELETE";
  correlationId: string;
  user: GatewayUser;
  span?: Span;
  spanName: string;
  parse: (payload: unknown) => T;
}) {
  const baseUrl = resolveServiceUrl("engagement");

  let payload: unknown;
  try {
    const response = await performServiceRequest<T>({
      serviceName: "engagement",
      baseUrl,
      path: options.path,
      method: options.method,
      correlationId: options.correlationId,
      user: options.user,
      parentSpan: options.span,
      spanName: options.spanName,
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Engagement service request failed",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  return options.parse(data);
}

export function reelLike(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementLikeData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/like`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelLike",
    parse: (payload) => {
      const parsed = engagementLikeDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelUnlike(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementLikeData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/like`,
    method: "DELETE",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelUnlike",
    parse: (payload) => {
      const parsed = engagementLikeDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelSave(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementSaveData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/save`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelSave",
    parse: (payload) => {
      const parsed = engagementSaveDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelUnsave(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementSaveData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/save`,
    method: "DELETE",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelUnsave",
    parse: (payload) => {
      const parsed = engagementSaveDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelAddView(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementViewData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/view`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelView",
    parse: (payload) => {
      const parsed = engagementViewDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelStats(
  reelId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementStatsData> {
  return requestEngagement({
    path: `/internal/reels/${reelId}/stats`,
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelStats",
    parse: (payload) => {
      const parsed = engagementStatsDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelLikedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UpstreamListItem[]> {
  return requestEngagement({
    path: "/internal/reels/liked",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelLikedList",
    parse: (payload) => {
      const parsed = upstreamListWithStatsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data.items;
    },
  });
}

export function reelSavedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UpstreamListItem[]> {
  return requestEngagement({
    path: "/internal/reels/saved",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelSavedList",
    parse: (payload) => {
      const parsed = upstreamListWithStatsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data.items;
    },
  });
}

export function seriesLike(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementLikeData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/like`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesLike",
    parse: (payload) => {
      const parsed = engagementLikeDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesUnlike(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementLikeData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/like`,
    method: "DELETE",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesUnlike",
    parse: (payload) => {
      const parsed = engagementLikeDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesSave(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementSaveData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/save`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesSave",
    parse: (payload) => {
      const parsed = engagementSaveDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesUnsave(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementSaveData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/save`,
    method: "DELETE",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesUnsave",
    parse: (payload) => {
      const parsed = engagementSaveDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesAddView(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementViewData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/view`,
    method: "POST",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesView",
    parse: (payload) => {
      const parsed = engagementViewDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesStats(
  seriesId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementStatsData> {
  return requestEngagement({
    path: `/internal/series/${seriesId}/stats`,
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesStats",
    parse: (payload) => {
      const parsed = engagementStatsDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesLikedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UpstreamListItem[]> {
  return requestEngagement({
    path: "/internal/series/liked",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesLikedList",
    parse: (payload) => {
      const parsed = upstreamListWithStatsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data.items;
    },
  });
}

export function seriesSavedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<UpstreamListItem[]> {
  return requestEngagement({
    path: "/internal/series/saved",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesSavedList",
    parse: (payload) => {
      const parsed = upstreamListWithStatsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data.items;
    },
  });
}

// Import batch schemas
import {
  batchInteractionBodySchema,
  batchInteractionDataSchema,
  type BatchInteractionBody,
  type BatchInteractionData,
} from "../schemas/engagement.schema";

// Batch interactions (simple version from origin)
export async function batchInteractions(
  body: BatchInteractionBody,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<BatchInteractionData> {
  const baseUrl = resolveServiceUrl("engagement");
  const validatedBody = batchInteractionBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<BatchInteractionData>({
      serviceName: "engagement",
      baseUrl,
      path: "/internal/interactions/batch",
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:engagement:batchInteractions",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to process batch interactions",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  const parsed = batchInteractionDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }

  return parsed.data;
}

// Batch actions (detailed version with results)
export async function processBatchActions(
  body: BatchActionRequest,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<BatchActionResponseData> {
  const baseUrl = resolveServiceUrl("engagement");
  const validatedBody = batchActionRequestSchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<BatchActionResponseData>({
      serviceName: "engagement",
      baseUrl,
      path: "/internal/batch",
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:engagement:batchActions",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to process batch engagement actions",
        error.cause
      );
    }
    throw error;
  }

  // Unwrap data if wrapped in global response format
  const data = (payload as any)?.data ?? payload;

  const parsed = batchActionResponseDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }

  return parsed.data;
}

// View Progress
export async function saveProgress(
  body: SaveProgressBody,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<ProgressResponse> {
  const baseUrl = resolveServiceUrl("engagement");
  const validatedBody = saveProgressBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<ProgressResponse>({
      serviceName: "engagement",
      baseUrl,
      path: "/client/progress",
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:engagement:saveProgress",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to save view progress",
        error.cause
      );
    }
    throw error;
  }

  // Unwrap data if wrapped in global response format
  const data = (payload as any)?.data ?? payload;
  console.log("[DEBUG saveProgress] Raw payload:", JSON.stringify(payload));
  console.log("[DEBUG saveProgress] Unwrapped data:", JSON.stringify(data));

  const parsed = progressResponseSchema.safeParse(data);
  if (!parsed.success) {
    console.error("[DEBUG saveProgress] Validation failed:", parsed.error);
    throw new Error(`Invalid response from engagement service: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function getProgress(
  episodeId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<ProgressResponse> {
  const baseUrl = resolveServiceUrl("engagement");

  let payload: unknown;
  try {
    const response = await performServiceRequest<ProgressResponse>({
      serviceName: "engagement",
      baseUrl,
      path: `/client/progress/${episodeId}`,
      method: "GET",
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:engagement:getProgress",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to get view progress",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  const parsed = progressResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }
  return parsed.data;
}

export async function addReviewProxy(
  seriesId: string,
  body: AddReviewBody,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<AddReviewResponse> {
  const baseUrl = resolveServiceUrl("engagement");
  const validatedBody = addReviewBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<AddReviewResponse>({
      serviceName: "engagement",
      baseUrl,
      path: `/client/reviews/${seriesId}`,
      method: "POST",
      correlationId,
      user,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:engagement:addReview",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to add review",
        error.cause
      );
    }
    throw error;
  }

  const data = (payload as any)?.data ?? payload;
  const parsed = addReviewResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }
  return parsed.data;
}

// Admin: User Content Analytics
export async function getUserContentStatsProxy(
  userId: string,
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<unknown> {
  const baseUrl = resolveServiceUrl("engagement");

  let payload: unknown;
  try {
    const response = await performServiceRequest<unknown>({
      serviceName: "engagement",
      baseUrl,
      path: `/internal/analytics/users/${userId}/content`,
      method: "GET",
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:engagement:getUserContentStats",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Failed to fetch user content stats",
        error.cause
      );
    }
    throw error;
  }

  return (payload as any)?.data ?? payload;
}
