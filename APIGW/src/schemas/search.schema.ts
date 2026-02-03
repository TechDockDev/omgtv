import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

export const searchQuerySchema = z.object({
  q: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20).optional(),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const searchResultSchema = z.object({
  id: z.string(),
  type: z.literal("series"),
  title: z.string(),
  subtitle: z.string().nullable(),
  duration: z.string().nullable(),
  ThumbnailUrl: z.string().url().nullable(),
  watchedDuration: z.number().nullable(),
  progress: z.number().nullable(),
  rating: z.number(),
  lastWatchedAt: z.string().datetime().nullable(),
  series_id: z.string(),
  engagement: z.object({
    likeCount: z.number(),
    viewCount: z.number(),
    isLiked: z.boolean(),
    isSaved: z.boolean(),
    averageRating: z.number(),
    reviewCount: z.number(),
  }),
});

export const searchHistoryItemSchema = z.object({
  id: z.string(),
  query: z.string(),
  createdAt: z.string().or(z.date()),
});

export const searchResponseSchema = z.object({
  items: z.array(searchResultSchema),
  history: z.array(searchHistoryItemSchema).optional(),
  nextCursor: z.string().optional().nullable(),
  total: z.number().optional(),
});

export const searchSuccessResponseSchema =
  createSuccessResponseSchema(searchResponseSchema);

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchHistoryItem = z.infer<typeof searchHistoryItemSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchSuccessResponse = SuccessResponse<SearchResponse>;
