import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

export const searchQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().positive().max(100).default(20).optional(),
  cursor: z.string().optional(),
});

export const searchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  type: z.enum(["video", "channel", "playlist"]).default("video"),
});

export const searchResponseSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: z.string().optional(),
});

export const searchSuccessResponseSchema =
  createSuccessResponseSchema(searchResponseSchema);

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchSuccessResponse = SuccessResponse<SearchResponse>;
