import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/reply-from";
import { loadConfig, resolveServiceUrl } from "../config";

// Audience registration is a published contract (raw bodies, `{ error: {...} }`
// errors), so these routes stream the upstream response straight through and
// opt out of the gateway's success envelope. They live on EngagementService.

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

// Identity is derived ONLY from the verified token. Anything a client sends in
// these headers is dropped first, so a public route can't be spoofed into
// treating the caller as someone else.
const IDENTITY_HEADERS = [
  "x-user-id",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
  "x-admin-id",
  "x-customer-id",
  "x-service-token",
];

async function forward(request: FastifyRequest, reply: FastifyReply, upstreamPath: string) {
  const config = loadConfig();
  const target = new URL(upstreamPath, resolveServiceUrl("engagement"));
  const queryStart = request.url.indexOf("?");
  if (queryStart !== -1) target.search = request.url.slice(queryStart);

  await reply.from(target.toString(), {
    rewriteRequestHeaders: (_req, headers) => {
      const next: Record<string, string | string[] | undefined> = { ...headers };
      for (const name of IDENTITY_HEADERS) delete next[name];
      delete next.authorization; // the user's JWT is not forwarded downstream

      next["x-correlation-id"] = request.correlationId;
      next["x-forwarded-for"] = request.ip;
      if (request.user) {
        next["x-user-id"] = request.user.id;
        next["x-user-type"] = request.user.userType;
        next["x-user-roles"] = request.user.roles.join(",");
      }
      if (config.SERVICE_AUTH_TOKEN) {
        next["x-service-token"] = config.SERVICE_AUTH_TOKEN;
        next.authorization = `Bearer ${config.SERVICE_AUTH_TOKEN}`;
      }
      return next;
    },
  });
}

export default async function audienceRoutes(fastify: FastifyInstance) {
  // Public: a bearer token is optional. When present it is verified and the
  // caller's identity is forwarded; when absent the request is anonymous.
  const publicConfig = {
    auth: { public: true },
    rateLimitPolicy: "anonymous" as const,
    envelope: { disabled: true },
  };

  // GET /api/v1/audience/banner
  fastify.route({
    method: "GET",
    url: "/banner",
    // Hit on every app open and many mobile users share a carrier IP, so this
    // gets more headroom than the default anonymous limit.
    config: { ...publicConfig, gatewayRateLimit: { max: 120 } },
    handler: (request, reply) => forward(request, reply, "/client/audience/banner"),
  });

  // GET /api/v1/audience/registration/status
  fastify.route({
    method: "GET",
    url: "/registration/status",
    config: publicConfig,
    handler: (request, reply) => forward(request, reply, "/client/audience/registration/status"),
  });

  // POST /api/v1/audience/registration (multipart/form-data)
  fastify.route({
    method: "POST",
    url: "/registration",
    config: {
      ...publicConfig,
      gatewayRateLimit: { max: 30 },
      security: { bodyLimit: MAX_UPLOAD_BYTES },
    },
    handler: (request, reply) => forward(request, reply, "/client/audience/registration"),
  });

  // --- Admin ---------------------------------------------------------------
  const adminConfig = {
    auth: { public: false },
    rateLimitPolicy: "admin" as const,
    envelope: { disabled: true },
  };
  const adminOnly = [fastify.authorize(["admin"])];

  fastify.route({
    method: "GET",
    url: "/admin/config",
    config: adminConfig,
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/config"),
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/config",
    config: { ...adminConfig, security: { bodyLimit: 32 * 1024 } },
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/config"),
  });

  fastify.route({
    method: "GET",
    url: "/admin/email-template/image",
    config: adminConfig,
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/email-template/image"),
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/email-template/image",
    config: { ...adminConfig, security: { bodyLimit: 32 * 1024 } },
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/email-template/image"),
  });

  fastify.route({
    method: "GET",
    url: "/admin/registrations",
    config: adminConfig,
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/registrations"),
  });

  fastify.route({
    method: "GET",
    url: "/admin/registrations/export",
    config: adminConfig,
    preHandler: adminOnly,
    handler: (request, reply) => forward(request, reply, "/admin/audience/registrations/export"),
  });

  fastify.route<{ Params: { id: string } }>({
    method: "GET",
    url: "/admin/registrations/:id",
    config: adminConfig,
    preHandler: adminOnly,
    handler: (request, reply) =>
      forward(request, reply, `/admin/audience/registrations/${encodeURIComponent(request.params.id)}`),
  });

  fastify.route<{ Params: { id: string } }>({
    method: "PATCH",
    url: "/admin/registrations/:id/status",
    config: { ...adminConfig, security: { bodyLimit: 4 * 1024 } },
    preHandler: adminOnly,
    handler: (request, reply) =>
      forward(
        request,
        reply,
        `/admin/audience/registrations/${encodeURIComponent(request.params.id)}/status`
      ),
  });
}
