import "fastify";
import type { GatewayUser } from "./index";
import type { AuditEvent } from "./audit";

declare module "fastify" {
  interface FastifyInstance {
    verifyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    authorize(
      roles: readonly GatewayUser["roles"][number][]
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    redis: import("ioredis").Redis;
    publishAuditEvent(event: AuditEvent): Promise<void>;
  }

  interface FastifyRequest {
    user?: GatewayUser;
    correlationId: string;
    telemetrySpan?: import("@opentelemetry/api").Span;
  }

  interface FastifyReply {
    setRateLimitHeaders(context: {
      max: number;
      remaining: number;
      reset: number;
    }): void;
  }

  interface FastifyContextConfig {
    auth?: { public?: boolean };
    gatewayRateLimit?: { skip?: boolean; max?: number; timeWindowMs?: number };
    rateLimitPolicy?: "anonymous" | "authenticated" | "admin";
    security?: { bodyLimit?: number };
    envelope?: { disabled?: boolean };
    accessControl?: { allowAnyAuthenticated?: boolean };
  }
}
