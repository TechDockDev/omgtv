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

// User state schemas for engagement enrichment
const userStateItemSchema = z.object({
  contentType: z.enum(["reel", "series"]),
  contentId: z.string().uuid(),
});

const userStateEntrySchema = z.object({
  isLiked: z.boolean(),
  isSaved: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  saveCount: z.number().int().nonnegative(),
  averageRating: z.number().optional().default(0),
  reviewCount: z.number().optional().default(0),
});

const userStateResponseSchema = z.object({
  states: z.record(userStateEntrySchema),
});

export type ContinueWatchEntry = z.infer<typeof continueWatchEntrySchema>;
export type ContinueWatchQuery = z.infer<typeof continueWatchQuerySchema>;
export type UserStateEntry = z.infer<typeof userStateEntrySchema>;
export type UserStateItem = z.infer<typeof userStateItemSchema>;

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

    // Unwrap data envelope if present
    const data = (response.payload as any)?.data ?? response.payload;
    const parsed = continueWatchResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Invalid response from EngagementService");
    }

    return parsed.data.entries;
  }

  /**
   * Get user state for multiple content items.
   * Returns like/save state and engagement counts for each item.
   */
  async getUserStates(params: {
    userId: string;
    items: UserStateItem[];
  }): Promise<Record<string, UserStateEntry>> {
    if (params.items.length === 0) {
      return {};
    }

    const response: ServiceRequestResult<unknown> = await performServiceRequest({
      serviceName: "engagement",
      baseUrl: this.options.baseUrl,
      path: "/internal/user-state",
      method: "POST",
      body: { items: params.items },
      headers: { "x-user-id": params.userId },
      timeoutMs: this.options.timeoutMs,
      spanName: "client:engagement:getUserStates",
    });

    // Unwrap data envelope if present
    const data = (response.payload as any)?.data ?? response.payload;
    const parsed = userStateResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.error("Invalid user state response:", parsed.error);
      return {};
    }

    return parsed.data.states;
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
      user_phone?: string;
      rating: number;
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
      user_phone: z.string().optional(),
      rating: z.number(),
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

    // Unwrap data envelope if present
    const data = (response.payload as any)?.data ?? response.payload;
    const parsed = reviewsResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Invalid response from EngagementService (reviews)");
    }
    return parsed.data;
  }

  async addReview(params: {
    seriesId: string;
    userId: string;
    userName: string;
    rating: number;
    comment: string;
  }): Promise<{ review_id: string }> {
    const body = {
      user_name: params.userName,
      rating: params.rating,
      comment: params.comment
    };

    const response: ServiceRequestResult<unknown> = await performServiceRequest({
      serviceName: "engagement",
      baseUrl: this.options.baseUrl,

      // I implemented it in `routes/client.ts` but `ContentService` usually calls `internal` routes?
      // No, `EngagementClient` in ContentService is backend-to-backend.
      // But I exposed it in `client.ts` (public). 
      // `internal.ts` ALSO has `addReview`.
      // I should use internal route if possible or client route if I want to simulate client.
      // `internal.ts` route: POST /series/:seriesId/reviews
      // `client.ts` route: POST /reviews/:seriesId
      // Let's use internal route since we are a service.
      // Internal route implementation in `internal.ts` calls `addReview`.
      // Wait, I updated `internal.ts` to pass `title`? No, I removed `title`.
      // So I can use internal route.
      path: `/internal/series/${params.seriesId}/reviews`,
      method: "POST",
      body,
      headers: { "x-user-id": params.userId },
      timeoutMs: this.options.timeoutMs,
      spanName: "client:engagement:addReview"
    });

    const resultSchema = z.object({ review_id: z.string() });
    const data = (response.payload as any)?.data ?? response.payload;
    const parsed = resultSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Invalid response from EngagementService (addReview)");
    }
    return parsed.data;
  }

  async getUserState(params: {
    userId: string;
    items: Array<{ contentType: "reel" | "series"; contentId: string }>;
  }): Promise<Record<string, UserStateEntry>> {
    if (params.items.length === 0) {
      return {};
    }

    const userStateRequestSchema = z.object({
      items: z.array(
        z.object({
          contentType: z.enum(["reel", "series"]),
          contentId: z.string().uuid(),
        })
      ),
    });

    const body = userStateRequestSchema.parse({ items: params.items });

    const response: ServiceRequestResult<unknown> = await performServiceRequest({
      serviceName: "engagement",
      baseUrl: this.options.baseUrl,
      path: "/internal/user-state",
      method: "POST",
      body,
      headers: {
        "x-user-id": params.userId,
      },
      timeoutMs: this.options.timeoutMs,
      spanName: "client:engagement:getUserState",
    });

    console.log("[DEBUG getUserState] raw response.payload:", JSON.stringify(response.payload));

    // Unwrap data envelope if present
    const data = (response.payload as any)?.data ?? response.payload;
    console.log("[DEBUG getUserState] unwrapped data:", JSON.stringify(data));

    const parsed = userStateResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.log("[DEBUG getUserState] parse error:", JSON.stringify(parsed.error));
      throw new Error("Invalid response from EngagementService (user-state)");
    }

    return parsed.data.states;
  }


  async getStatsBatch(params: {
    type: "reel" | "series";
    ids: string[];
  }): Promise<Record<string, { likes: number; views: number; saves: number; averageRating: number; reviewCount: number }>> {
    if (params.ids.length === 0) {
      return {};
    }

    const statsBatchRequestSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
    });

    const statsSchema = z.object({
      likes: z.number().int().nonnegative(),
      views: z.number().int().nonnegative(),
      saves: z.number().int().nonnegative(),
      averageRating: z.number().optional().default(0),
      reviewCount: z.number().optional().default(0),
    });

    const statsBatchResponseSchema = z.object({
      stats: z.record(statsSchema),
    });

    // Chunking to respect max batch size if needed, but for now assuming caller respects it or we implement chunking here.
    // Let's implement simple chunking to be safe (200 is max).
    const results: Record<string, { likes: number; views: number; saves: number; averageRating: number; reviewCount: number }> = {};
    const chunkSize = 200;

    for (let i = 0; i < params.ids.length; i += chunkSize) {
      const chunk = params.ids.slice(i, i + chunkSize);

      try {
        const body = statsBatchRequestSchema.parse({ ids: chunk });

        const response: ServiceRequestResult<unknown> = await performServiceRequest({
          serviceName: "engagement",
          baseUrl: this.options.baseUrl,
          path: `/internal/${params.type === 'series' ? 'series' : 'reels'}/stats`,
          method: "POST",
          body,
          timeoutMs: this.options.timeoutMs,
          spanName: `client:engagement:getStatsBatch:${params.type}`,
        });

        // Unwrap data envelope if present
        const data = (response.payload as any)?.data ?? response.payload;
        const parsed = statsBatchResponseSchema.safeParse(data);
        if (parsed.success) {
          // Create object with defaults
          const statsWithDefaults = Object.entries(parsed.data.stats).reduce((acc, [key, stat]) => {
            acc[key] = {
              likes: stat.likes,
              views: stat.views,
              saves: stat.saves,
              averageRating: stat.averageRating ?? 0,
              reviewCount: stat.reviewCount ?? 0,
            };
            return acc;
          }, {} as Record<string, { likes: number; views: number; saves: number; averageRating: number; reviewCount: number }>);

          Object.assign(results, statsWithDefaults);
        } else {
          console.error(`Invalid stats batch response for ${params.type}:`, parsed.error);
        }
      } catch (error) {
        // Fallback for partial failures? Or just log.
        console.error(`Failed to fetch stats batch for ${params.type} chunk`, error);
      }
    }

    return results;
  }
}

