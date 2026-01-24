import { z } from "zod";

export const engagementEventBodySchema = z.object({
  videoId: z.string().uuid(),
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
  episodeId: z.string().uuid(),
  watchedDuration: z.number().int().nonnegative(),
  totalDuration: z.number().int().positive(),
  lastWatchedAt: z.string().datetime().nullable().optional(),
  isCompleted: z.boolean().optional(),
});

export const continueWatchQuerySchema = z.object({
  userId: z.string().uuid(),
  episodeIds: z.array(z.string().uuid()).min(1).max(100),
  limit: z.number().int().positive().max(100).optional(),
});

export const continueWatchResponseSchema = z.object({
  entries: z.array(
    z.object({
      episode_id: z.string().uuid(),
      watched_duration: z.number().int().nonnegative(),
      total_duration: z.number().int().positive(),
      last_watched_at: z.string().datetime().nullable(),
      is_completed: z.boolean(),
    })
  ),
});

export const entityIdParamsSchema = z.object({
  entityId: z.string().uuid(),
});

export const reelIdParamsSchema = z.object({
  reelId: z.string().uuid(),
});

export const seriesIdParamsSchema = z.object({
  seriesId: z.string().uuid(),
});

export const statsSchema = z.object({
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
});

export const saveResponseSchema = z.object({
  saved: z.boolean(),
});

export const likeResponseSchema = z.object({
  liked: z.boolean(),
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
});

export const viewResponseSchema = z.object({
  views: z.number().int().nonnegative(),
});

export const listResponseSchema = z.object({
  ids: z.array(z.string().uuid()),
});

export const listItemWithStatsSchema = z.object({
  id: z.string().uuid(),
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
});

export const listWithStatsResponseSchema = z.object({
  items: z.array(listItemWithStatsSchema),
});

export const statsBatchRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
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

// Batch action schemas
export const batchActionItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string().uuid(),
  action: z.enum(["like", "unlike", "save", "unsave", "view"]),
});

export const batchActionRequestSchema = z.object({
  actions: z.array(batchActionItemSchema).min(1).max(50),
});

export const batchActionResultSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string().uuid(),
  action: z.enum(["like", "unlike", "save", "unsave", "view"]),
  success: z.boolean(),
  result: z
    .object({
      liked: z.boolean().optional(),
      saved: z.boolean().optional(),
      likes: z.number().int().nonnegative().optional(),
      views: z.number().int().nonnegative().optional(),
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
  contentId: z.string().uuid(),
});

export const userStateRequestSchema = z.object({
  items: z.array(userStateItemSchema).min(1).max(100),
});

export const userStateEntrySchema = z.object({
  likeCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
  isSaved: z.boolean(),
});

export const userStateResponseSchema = z.object({
  states: z.record(userStateEntrySchema),
});

export type UserStateItem = z.infer<typeof userStateItemSchema>;
export type UserStateRequest = z.infer<typeof userStateRequestSchema>;
export type UserStateEntry = z.infer<typeof userStateEntrySchema>;
export type UserStateResponse = z.infer<typeof userStateResponseSchema>;
