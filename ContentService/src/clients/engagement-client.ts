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
  ) {}

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
}
