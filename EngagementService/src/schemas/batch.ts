import { z } from "zod";

export const contentTypeSchema = z.enum(["reel", "series"]);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const actionSchema = z.enum(["like", "unlike", "save", "unsave", "view"]);
export type Action = z.infer<typeof actionSchema>;

// Batch interaction request
export const batchInteractionItemSchema = z.object({
    contentType: contentTypeSchema,
    contentId: z.string().uuid(),
    action: actionSchema,
});

export const batchInteractionRequestSchema = z.object({
    actions: z.array(batchInteractionItemSchema).min(1).max(100),
});

export const batchInteractionResponseSchema = z.object({
    processed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative().optional(),
});

export type BatchInteractionRequest = z.infer<typeof batchInteractionRequestSchema>;
export type BatchInteractionResponse = z.infer<typeof batchInteractionResponseSchema>;

// User state request (for enriching content responses)
export const userStateItemSchema = z.object({
    contentType: contentTypeSchema,
    contentId: z.string().uuid(),
});

export const userStateRequestSchema = z.object({
    items: z.array(userStateItemSchema).min(1).max(200),
});

export const userStateEntrySchema = z.object({
    isLiked: z.boolean(),
    isSaved: z.boolean(),
    likeCount: z.number().int().nonnegative(),
    viewCount: z.number().int().nonnegative(),
});

export const userStateResponseSchema = z.object({
    states: z.record(userStateEntrySchema),
});

export type UserStateRequest = z.infer<typeof userStateRequestSchema>;
export type UserStateResponse = z.infer<typeof userStateResponseSchema>;
export type UserStateEntry = z.infer<typeof userStateEntrySchema>;
