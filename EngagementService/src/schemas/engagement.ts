import { z } from "zod";

export const engagementEventBodySchema = z.object({
  videoId: z.string(),
  action: z.enum(["like", "unlike", "view", "favorite"]).default("like"),
  metadata: z
    .object({
      source: z.enum(["mobile", "web", "tv"]).optional(),
    })
    .optional(),
});

export const engagementEventMetricsSchema = z.object({
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
});

export const continueWatchUpsertSchema = z.object({
  userId: z.string().uuid(),
  episodeId: z.string(),
  watchedDuration: z.number().int().nonnegative(),
  totalDuration: z.number().int().positive(),
  lastWatchedAt: z.string().datetime().nullable().optional(),
  isCompleted: z.boolean().optional(),
});

export const continueWatchQuerySchema = z.object({
  userId: z.string().uuid(),
  episodeIds: z.array(z.string()).min(1).max(100),
  limit: z.number().int().positive().max(100).optional(),
});

export const continueWatchResponseSchema = z.object({
  entries: z.array(
    z.object({
      episode_id: z.string(),
      watched_duration: z.number().int().nonnegative(),
      total_duration: z.number().int().positive(),
      last_watched_at: z.string().datetime().nullable(),
      is_completed: z.boolean(),
    })
  ),
});

export const entityIdParamsSchema = z.object({
  entityId: z.string(),
});

export const reelIdParamsSchema = z.object({
  reelId: z.string(),
});

export const seriesIdParamsSchema = z.object({
  seriesId: z.string(),
});

export const statsSchema = z.object({
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
  averageRating: z.number().nonnegative().optional().default(0),
  reviewCount: z.number().int().nonnegative().optional().default(0),
});

export const saveResponseSchema = z.object({
  saved: z.boolean(),
});

export const likeResponseSchema = z.object({
  liked: z.boolean(),
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
});

export const viewResponseSchema = z.object({
  views: z.number().int().nonnegative(),
});

export const listResponseSchema = z.object({
  ids: z.array(z.string()),
});

export const listItemWithStatsSchema = z.object({
  id: z.string(),
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
  averageRating: z.number().nonnegative().optional().default(0),
  reviewCount: z.number().int().nonnegative().optional().default(0),
});

export const listWithStatsResponseSchema = z.object({
  items: z.array(listItemWithStatsSchema),
});

export const statsBatchRequestSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});

export const statsBatchResponseSchema = z.object({
  stats: z.record(statsSchema),
});

export type EngagementEventBody = z.infer<typeof engagementEventBodySchema>;
export type EngagementEventMetrics = z.infer<
  typeof engagementEventMetricsSchema
>;
export type ContinueWatchUpsert = z.infer<typeof continueWatchUpsertSchema>;
export type ContinueWatchQuery = z.infer<typeof continueWatchQuerySchema>;
export type ContinueWatchResponse = z.infer<typeof continueWatchResponseSchema>;

export type ReelIdParams = z.infer<typeof reelIdParamsSchema>;
export type SeriesIdParams = z.infer<typeof seriesIdParamsSchema>;
export type Stats = z.infer<typeof statsSchema>;
export type SaveResponse = z.infer<typeof saveResponseSchema>;
export type LikeResponse = z.infer<typeof likeResponseSchema>;
export type ViewResponse = z.infer<typeof viewResponseSchema>;
export type ListResponse = z.infer<typeof listResponseSchema>;
export type ListItemWithStats = z.infer<typeof listItemWithStatsSchema>;
export type ListWithStatsResponse = z.infer<typeof listWithStatsResponseSchema>;
export type StatsBatchRequest = z.infer<typeof statsBatchRequestSchema>;
export type StatsBatchResponse = z.infer<typeof statsBatchResponseSchema>;

// Analytics Event schema
export const appEventItemSchema = z.object({
  eventType: z.string(),
  eventData: z.record(z.any()).optional(),
  deviceId: z.string(),
  guestId: z.string().optional(),
  createdAt: z.string().optional(),
});

// Batch action schemas
export const batchActionItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string(),
  action: z.enum(["like", "unlike", "save", "unsave", "view"]),
});

export const batchActionRequestSchema = z.object({
  actions: z.array(batchActionItemSchema).optional(),
  events: z.array(appEventItemSchema).optional(),
}).refine(data => (data.actions && data.actions.length > 0) || (data.events && data.events.length > 0), {
  message: "Provide at least one action or event",
});

export const batchActionResultSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string(),
  action: z.enum(["like", "unlike", "save", "unsave", "view"]),
  success: z.boolean(),
  result: z
    .object({
      liked: z.boolean().optional(),
      saved: z.boolean().optional(),
      likes: z.number().int().nonnegative().optional(),
      views: z.number().int().nonnegative().optional(),
      saves: z.number().int().nonnegative().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

export const batchActionResponseSchema = z.object({
  results: z.array(batchActionResultSchema),
  processed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type BatchActionItem = z.infer<typeof batchActionItemSchema>;
export type BatchActionRequest = z.infer<typeof batchActionRequestSchema>;
export type BatchActionResult = z.infer<typeof batchActionResultSchema>;
export type BatchActionResponse = z.infer<typeof batchActionResponseSchema>;

// User state schemas (for ContentService enrichment)
export const userStateItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string(),
});

export const userStateRequestSchema = z.object({
  items: z.array(userStateItemSchema).min(1).max(100),
});

export const userStateEntrySchema = z.object({
  likeCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  saveCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
  isSaved: z.boolean(),
  averageRating: z.number().optional().default(0),
  reviewCount: z.number().int().nonnegative().optional().default(0),
});

export const userStateResponseSchema = z.object({
  states: z.record(userStateEntrySchema),
});

export type UserStateItem = z.infer<typeof userStateItemSchema>;
export type UserStateRequest = z.infer<typeof userStateRequestSchema>;
export type UserStateEntry = z.infer<typeof userStateEntrySchema>;
export type UserStateResponse = z.infer<typeof userStateResponseSchema>;
