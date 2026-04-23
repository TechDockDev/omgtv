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
  isTrial: z.boolean().optional(),
  contentType: z.enum(["REEL", "EPISODE"]),
  freeLimits: z.record(z.any()).optional(),
});

export type EntitlementRequest = z.infer<typeof entitlementRequestSchema>;
export type ContentEntitlement = {
  canWatch: boolean;
  planPurchased: boolean;
  isTrial: boolean;
};

const unlockStatusRequestSchema = z.object({
  userId: z.string().min(1),
  episodeIds: z.array(z.string()),
});

const unlockStatusResponseSchema = z.object({
  unlockedIds: z.array(z.string()),
});

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
    const cacheKey = `entitlement:v2:${body.userId}:${body.contentType}`;
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
      isTrial: parsed.data.isTrial === true,
    };

    if (redis) {
      await redis
        .set(cacheKey, JSON.stringify(result), "EX", cacheTtlSeconds)
        .catch(() => {});
    }

    return result;
  }

  async checkCoinUnlockStatus(userId: string, episodeIds: string[]): Promise<Set<string>> {
    if (!episodeIds.length) return new Set();

    const body = unlockStatusRequestSchema.parse({ userId, episodeIds });

    try {
      const response = await performServiceRequest<unknown>({
        serviceName: "subscription",
        baseUrl: this.options.baseUrl,
        path: "/internal/episodes/unlock-status",
        method: "POST",
        body,
        timeoutMs: this.options.timeoutMs,
        spanName: "client:subscription:coin-unlock-status",
      });

      const parsed = unlockStatusResponseSchema.safeParse(response.payload);
      if (!parsed.success) return new Set();

      return new Set(parsed.data.unlockedIds);
    } catch {
      return new Set();
    }
  }
}
