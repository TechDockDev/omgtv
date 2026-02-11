import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

export const engagementEventBodySchema = z.object({
  videoId: z.string().uuid(),
  action: z.enum(["like", "unlike", "view", "favorite"]).default("like"),
  metadata: z
    .object({
      source: z.enum(["mobile", "web", "tv"]).optional(),
    })
    .optional(),
});

export const engagementEventDataSchema = z.object({
  likes: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
});

export const engagementEventSuccessResponseSchema = createSuccessResponseSchema(
  engagementEventDataSchema
);

export const engagementIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const engagementStatsDataSchema = z.object({
  likes: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  saves: z.number().int().nonnegative(),
});

export const engagementLikeDataSchema = engagementStatsDataSchema.extend({
  liked: z.boolean(),
});

export const engagementSaveDataSchema = z.object({
  saved: z.boolean(),
});

export const engagementViewDataSchema = z.object({
  views: z.number().int().nonnegative(),
});

export const engagementListDataSchema = z.object({
  items: z.array(z.any()),
});

export const engagementStatsSuccessResponseSchema = createSuccessResponseSchema(
  engagementStatsDataSchema
);

export const engagementLikeSuccessResponseSchema = createSuccessResponseSchema(
  engagementLikeDataSchema
);

export const engagementSaveSuccessResponseSchema = createSuccessResponseSchema(
  engagementSaveDataSchema
);

export const engagementViewSuccessResponseSchema = createSuccessResponseSchema(
  engagementViewDataSchema
);

export const engagementListSuccessResponseSchema = createSuccessResponseSchema(
  engagementListDataSchema
);

export type EngagementEventBody = z.infer<typeof engagementEventBodySchema>;
export type EngagementEventData = z.infer<typeof engagementEventDataSchema>;
export type EngagementEventSuccessResponse =
  SuccessResponse<EngagementEventData>;

export type EngagementIdParams = z.infer<typeof engagementIdParamsSchema>;
export type EngagementStatsData = z.infer<typeof engagementStatsDataSchema>;
export type EngagementLikeData = z.infer<typeof engagementLikeDataSchema>;
export type EngagementSaveData = z.infer<typeof engagementSaveDataSchema>;
export type EngagementViewData = z.infer<typeof engagementViewDataSchema>;
export type EngagementListData = z.infer<typeof engagementListDataSchema>;

// Batch interaction schemas (from origin - simple version)
export const batchInteractionItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string().uuid(),
  action: z.enum(["like", "unlike", "save", "unsave", "view"]),
});

export const batchInteractionBodySchema = z.object({
  actions: z.array(batchInteractionItemSchema).min(1).max(100),
});

export const batchInteractionDataSchema = z.object({
  processed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative().optional(),
});

export const batchInteractionSuccessResponseSchema = createSuccessResponseSchema(
  batchInteractionDataSchema
);

export type BatchInteractionBody = z.infer<typeof batchInteractionBodySchema>;
export type BatchInteractionData = z.infer<typeof batchInteractionDataSchema>;

// Analytics Event schema
export const appEventItemSchema = z.object({
  eventType: z.string(),
  eventData: z.record(z.any()).optional(),
  deviceId: z.string(),
  guestId: z.string().optional(),
  createdAt: z.string().optional(),
});

// Batch action schemas (detailed version with results)
export const batchActionItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string().uuid(),
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
  contentId: z.string().uuid(),
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

export const batchActionResponseDataSchema = z.object({
  results: z.array(batchActionResultSchema),
  processed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const batchActionSuccessResponseSchema = createSuccessResponseSchema(
  batchActionResponseDataSchema
);

export type BatchActionItem = z.infer<typeof batchActionItemSchema>;
export type BatchActionRequest = z.infer<typeof batchActionRequestSchema>;
export type BatchActionResult = z.infer<typeof batchActionResultSchema>;
export type BatchActionResponseData = z.infer<
  typeof batchActionResponseDataSchema
>;

// View Progress
export const saveProgressBodySchema = z.object({
  episodeId: z.string().uuid(),
  progressSeconds: z.coerce.number().nonnegative(),
  durationSeconds: z.coerce.number().positive(),
});

export const getProgressParamsSchema = z.object({
  episodeId: z.string().uuid(),
});

export const progressResponseSchema = z.object({
  progressSeconds: z.coerce.number().nonnegative(),
  durationSeconds: z.coerce.number().positive(),
  completedAt: z.string().nullable().optional(),
});

export type SaveProgressBody = z.infer<typeof saveProgressBodySchema>;
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

// Analytics
export const contentDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  thumbnailUrl: z.string().nullable(),
  manifestUrl: z.string().nullable(),
});

export const userContentAnalyticsResponseSchema = z.object({
  watchHistory: z.array(
    z.object({
      episodeId: z.string(),
      title: z.string(),
      thumbnailUrl: z.string().nullable(),
      manifestUrl: z.string().nullable(),
      progressSeconds: z.number(),
      durationSeconds: z.number(),
      isCompleted: z.boolean(),
      lastWatchedAt: z.string(),
    })
  ),
  likes: z.object({
    reels: z.array(contentDetailSchema),
    series: z.array(contentDetailSchema),
  }),
  saves: z.object({
    reels: z.array(contentDetailSchema),
    series: z.array(contentDetailSchema),
  }),
  ongoingSeries: z.array(z.any()),
  completedSeries: z.array(z.any()),
  stats: z.object({
    totalWatchTimeSeconds: z.number(),
    episodesStarted: z.number(),
    episodesCompleted: z.number(),
    totalLikes: z.number(),
    totalSaves: z.number(),
  }),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    totalHistory: z.number(),
    totalLikes: z.number(),
    totalSaves: z.number(),
  }),
});

export const userContentAnalyticsSuccessResponseSchema = createSuccessResponseSchema(
  userContentAnalyticsResponseSchema
);

// Reviews
export const addReviewBodySchema = z.object({
  user_name: z.string().min(1).optional(),
  rating: z.coerce.number().min(1).max(5),
  comment: z.string().min(1).max(2000),
});

export const addReviewResponseSchema = z.object({
  review_id: z.string(),
});

export const addReviewSuccessResponseSchema = createSuccessResponseSchema(
  addReviewResponseSchema
);

export type AddReviewBody = z.infer<typeof addReviewBodySchema>;
export type AddReviewResponse = z.infer<typeof addReviewResponseSchema>;


