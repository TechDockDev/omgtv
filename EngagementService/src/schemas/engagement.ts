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
export type StatsBatchRequest = z.infer<typeof statsBatchRequestSchema>;
export type StatsBatchResponse = z.infer<typeof statsBatchResponseSchema>;
