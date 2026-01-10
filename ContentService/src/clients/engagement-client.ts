import { z } from "zod";
import {
  performServiceRequest,
  type ServiceRequestResult,
} from "../utils/service-request";

const continueWatchQuerySchema = z.object({
  userId: z.string().uuid(),
  episodeIds: z.array(z.string().uuid()).min(1).max(100),
  limit: z.number().int().positive().max(100).optional(),
});

const continueWatchEntrySchema = z.object({
  episode_id: z.string().uuid(),
  watched_duration: z.number().int().nonnegative(),
  total_duration: z.number().int().positive(),
  last_watched_at: z.string().datetime().nullable(),
  is_completed: z.boolean(),
});

const continueWatchResponseSchema = z.object({
  entries: z.array(continueWatchEntrySchema),
});

export type ContinueWatchEntry = z.infer<typeof continueWatchEntrySchema>;
export type ContinueWatchQuery = z.infer<typeof continueWatchQuerySchema>;

export class EngagementClient {
  constructor(
    private readonly options: { baseUrl: string; timeoutMs?: number }
  ) { }

  async getContinueWatch(
    payload: ContinueWatchQuery
  ): Promise<ContinueWatchEntry[]> {
    const body = continueWatchQuerySchema.parse(payload);
    const response: ServiceRequestResult<unknown> = await performServiceRequest(
      {
        serviceName: "engagement",
        baseUrl: this.options.baseUrl,
        path: "/internal/progress/query",
        method: "POST",
        body,
        timeoutMs: this.options.timeoutMs,
        spanName: "client:engagement:continueWatch",
      }
    );

    const parsed = continueWatchResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new Error("Invalid response from EngagementService");
    }

    return parsed.data.entries;
  }

  async getReviews(params: {
    seriesId: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    summary: { average_rating: number; total_reviews: number };
    user_reviews: Array<{
      review_id: string;
      user_id: string;
      user_name: string;
      rating: number;
      title: string;
      comment: string;
      created_at: string;
    }>;
    next_cursor: string | null;
  }> {
    const response: ServiceRequestResult<unknown> = await performServiceRequest({
      serviceName: "engagement",
      baseUrl: this.options.baseUrl,
      path: `/internal/series/${params.seriesId}/reviews`,
      method: "GET",
      query: {
        limit: params.limit,
        cursor: params.cursor,
      },
      timeoutMs: this.options.timeoutMs,
      spanName: "client:engagement:getReviews",
    });

    const reviewSchema = z.object({
      review_id: z.string().uuid(),
      user_id: z.string().uuid(),
      user_name: z.string(),
      rating: z.number(),
      title: z.string(),
      comment: z.string(),
      created_at: z.string(),
    });

    const reviewsResponseSchema = z.object({
      summary: z.object({
        average_rating: z.number(),
        total_reviews: z.number(),
      }),
      user_reviews: z.array(reviewSchema),
      next_cursor: z.string().nullable(),
    });

    const parsed = reviewsResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new Error("Invalid response from EngagementService (reviews)");
    }
    return parsed.data;
  }
}
