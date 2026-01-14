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

    const parsed = continueWatchResponseSchema.safeParse(response.payload);
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

    const parsed = userStateResponseSchema.safeParse(response.payload);
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

  async getUserState(params: {
    userId: string;
    items: Array<{ contentType: "reel" | "series"; contentId: string }>;
  }): Promise<
    Record<
      string,
      {
        likeCount: number;
        viewCount: number;
        isLiked: boolean;
        isSaved: boolean;
      }
    >
  > {
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

    const userStateEntrySchema = z.object({
      likeCount: z.number().int().nonnegative(),
      viewCount: z.number().int().nonnegative(),
      isLiked: z.boolean(),
      isSaved: z.boolean(),
    });

    const userStateResponseSchema = z.object({
      states: z.record(userStateEntrySchema),
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
}

