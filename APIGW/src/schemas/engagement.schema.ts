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
  ids: z.array(z.string().uuid()),
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

// Batch interaction schemas
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

