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
} from "../schemas/engagement.schema";
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

  const parsed = engagementEventDataSchema.safeParse(payload);
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

  return options.parse(payload);
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
): Promise<EngagementListData> {
  return requestEngagement({
    path: "/internal/reels/liked",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelLikedList",
    parse: (payload) => {
      const parsed = engagementListDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function reelSavedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementListData> {
  return requestEngagement({
    path: "/internal/reels/saved",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:reelSavedList",
    parse: (payload) => {
      const parsed = engagementListDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
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
): Promise<EngagementListData> {
  return requestEngagement({
    path: "/internal/series/liked",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesLikedList",
    parse: (payload) => {
      const parsed = engagementListDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
    },
  });
}

export function seriesSavedList(
  correlationId: string,
  user: GatewayUser,
  span?: Span
): Promise<EngagementListData> {
  return requestEngagement({
    path: "/internal/series/saved",
    method: "GET",
    correlationId,
    user,
    span,
    spanName: "proxy:engagement:seriesSavedList",
    parse: (payload) => {
      const parsed = engagementListDataSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid response from engagement service");
      }
      return parsed.data;
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

  const parsed = batchInteractionDataSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from engagement service");
  }

  return parsed.data;
}
