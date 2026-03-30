import { z } from "zod";
import type { Redis } from "ioredis";
import { performServiceRequest } from "../utils/service-request";

const entitlementRequestSchema = z.object({
  userId: z.string().min(1),
  contentType: z.enum(["REEL", "EPISODE"]),
});

const entitlementResponseSchema = z.object({
  allowed: z.boolean(),
  planId: z.string(),
  status: z.string(),
  contentType: z.enum(["REEL", "EPISODE"]),
  freeLimits: z.record(z.any()).optional(),
});

export type EntitlementRequest = z.infer<typeof entitlementRequestSchema>;
export type ContentEntitlement = {
  canWatch: boolean;
  planPurchased: boolean;
};

export class SubscriptionClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      timeoutMs?: number;
      redis?: Redis;
      cacheTtlSeconds?: number;
    }
  ) {}

  async checkEntitlement(
    payload: EntitlementRequest
  ): Promise<ContentEntitlement> {
    const body = entitlementRequestSchema.parse(payload);
    const cacheKey = `entitlement:${body.userId}:${body.contentType}`;
    const { redis, cacheTtlSeconds = 300 } = this.options;

    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          return JSON.parse(cached) as ContentEntitlement;
        } catch {
          await redis.del(cacheKey).catch(() => {});
        }
      }
    }

    const response = await performServiceRequest<unknown>({
      serviceName: "subscription",
      baseUrl: this.options.baseUrl,
      path: "/internal/entitlements/check",
      method: "POST",
      body,
      timeoutMs: this.options.timeoutMs,
      spanName: "client:subscription:entitlement",
    });

    const parsed = entitlementResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new Error("Invalid response from SubscriptionService");
    }

    const planPurchased =
      parsed.data.status.trim().toUpperCase() !== "FREE" &&
      parsed.data.planId.trim().toLowerCase() !== "free";

    const result: ContentEntitlement = {
      canWatch: parsed.data.allowed,
      planPurchased,
    };

    if (redis) {
      await redis
        .set(cacheKey, JSON.stringify(result), "EX", cacheTtlSeconds)
        .catch(() => {});
    }

    return result;
  }
}
