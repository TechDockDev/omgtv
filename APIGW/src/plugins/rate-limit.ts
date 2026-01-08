import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import { getRateLimitConfig } from "../config";

const POLICIES = {
  anonymous: "anonymous",
  authenticated: "authenticated",
  admin: "admin",
} as const;

const DEFAULT_WINDOW_MS = 60_000;

function resolveUserKey(request: FastifyRequest) {
  const userId = request.user?.id;
  if (userId) return `user:${userId}`;
  const ip = request.ip;
  return `anon:${ip}`;
}

export interface RouteRateLimitConfig {
  rateLimitPolicy?: keyof typeof POLICIES;
  gatewayRateLimit?: { skip?: boolean; max?: number; timeWindowMs?: number };
}

export interface RateLimitSelectionInput {
  userType?: string | null;
  routeConfig?: RouteRateLimitConfig | null;
  rateConfig: ReturnType<typeof getRateLimitConfig>;
  defaultWindowMs?: number;
}

export interface RateLimitSelectionResult {
  name: keyof typeof POLICIES;
  max: number;
  windowMs: number;
}

export function selectRateLimitPolicy(
  input: RateLimitSelectionInput
): RateLimitSelectionResult | null {
  const {
    userType,
    routeConfig,
    rateConfig,
    defaultWindowMs = DEFAULT_WINDOW_MS,
  } = input;

  if (routeConfig?.gatewayRateLimit?.skip) {
    return null;
  }

  const explicitPolicy = routeConfig?.rateLimitPolicy;

  const computedPolicy = explicitPolicy
    ? explicitPolicy
    : userType === "ADMIN"
      ? POLICIES.admin
      : userType
        ? POLICIES.authenticated
        : POLICIES.anonymous;

  const baseMax = rateConfig[computedPolicy as keyof typeof rateConfig];
  const explicit = routeConfig?.gatewayRateLimit;

  return {
    name: computedPolicy,
    max: explicit?.max ?? baseMax,
    windowMs: explicit?.timeWindowMs ?? defaultWindowMs,
  };
}

export default fp(
  async function rateLimitPlugin(fastify) {
    const rateConfig = getRateLimitConfig();

    await fastify.register(rateLimit, {
      redis: fastify.redis,
      timeWindow: DEFAULT_WINDOW_MS,
      keyGenerator(request: FastifyRequest) {
        const policy = selectRateLimitPolicy({
          userType: request.user?.userType,
          routeConfig: request.routeOptions.config as RouteRateLimitConfig,
          rateConfig,
        });
        if (!policy) {
          return `skip:${request.id}`;
        }
        return `${policy.name}:${resolveUserKey(request)}`;
      },
      max(request: FastifyRequest, key: string) {
        if (key.startsWith("skip:")) {
          return Number.MAX_SAFE_INTEGER;
        }
        const policy = selectRateLimitPolicy({
          userType: request.user?.userType,
          routeConfig: request.routeOptions.config as RouteRateLimitConfig,
          rateConfig,
        });
        if (!policy) {
          return rateConfig.anonymous;
        }
        const scale = policy.windowMs / DEFAULT_WINDOW_MS;
        if (scale === 0) {
          return policy.max;
        }
        if (scale === 1) {
          return policy.max;
        }
        return Math.max(1, Math.floor(policy.max / scale));
      },
      async onExceeded(request: FastifyRequest, key: string) {
        if (key.startsWith("skip:")) {
          return;
        }
        const policy = selectRateLimitPolicy({
          userType: request.user?.userType,
          routeConfig: request.routeOptions.config as RouteRateLimitConfig,
          rateConfig,
        });
        await fastify.publishAuditEvent({
          type: "rate_limit.blocked",
          correlationId: request.correlationId,
          subject: request.user?.id ?? resolveUserKey(request),
          principal: request.user?.id,
          ip: request.ip,
          tenantId: request.user?.tenantId,
          metadata: {
            policy: policy?.name ?? "unknown",
            max: policy?.max ?? rateConfig.anonymous,
            windowMs: policy?.windowMs ?? DEFAULT_WINDOW_MS,
            path: request.url,
            method: request.method,
          },
        });
      },
    });
  },
  { name: "rate-limit", dependencies: ["redis"] }
);
