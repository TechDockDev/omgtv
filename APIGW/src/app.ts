import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import replyFrom from "@fastify/reply-from";
import type { FastifyInstance, FastifyContextConfig } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import formbody from "@fastify/formbody";
import {
  loadConfig,
  getCorsOrigins,
  getCdnHosts,
  isProduction,
} from "./config";
import tracingPlugin from "./plugins/tracing";
import redisPlugin from "./plugins/redis";
import auditPlugin from "./plugins/audit";
import authPlugin from "./plugins/auth";
import rateLimitPlugin from "./plugins/rate-limit";
import swaggerPlugin from "./plugins/swagger";
import authRoutes from "./routes/auth.routes";
import uploadRoutes from "./routes/upload.routes";
import contentRoutes from "./routes/content.routes";
import engagementRoutes from "./routes/engagement.routes";
import searchRoutes from "./routes/search.routes";
import streamingRoutes from "./routes/streaming.routes";
import proxyRoutes from "./routes/proxy.route";
import { wrapError, wrapSuccess } from "./utils/envelope";
import { ZodError } from "zod";

export async function createApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization"],
    },
    trustProxy: config.SERVER_TRUST_PROXY,
    bodyLimit: config.SERVER_BODY_LIMIT,
    disableRequestLogging: isProduction() && !config.ENABLE_REQUEST_LOGGING,
    ajv: {
      customOptions: {
        removeAdditional: true,
        coerceTypes: "array",
        useDefaults: true,
      },
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register global envelope + error handling early so it applies to all routes.
  app.addHook("preSerialization", async (request, reply, payload) => {
    const contextConfig = request.context.config as
      | (FastifyContextConfig & { envelope?: { disabled?: boolean } })
      | undefined;
    if (contextConfig?.envelope?.disabled) {
      return payload;
    }

    if (reply.sent) {
      return payload;
    }

    if (request.raw.method === "HEAD") {
      return payload;
    }

    if (reply.statusCode >= 300 && reply.statusCode < 400) {
      return payload;
    }

    const contentType = reply.getHeader("content-type");
    if (
      typeof contentType === "string" &&
      !contentType.toLowerCase().includes("application/json")
    ) {
      return payload;
    }

    if (Buffer.isBuffer(payload)) {
      return payload;
    }

    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as { pipe?: unknown }).pipe === "function"
    ) {
      return payload;
    }

    if (
      payload &&
      typeof payload === "object" &&
      "success" in payload &&
      "statusCode" in payload
    ) {
      return payload;
    }

    // If an upstream/default Fastify error payload reaches preSerialization,
    // wrap it as an error envelope so it matches declared error response schemas.
    if (reply.statusCode >= 400) {
      if (
        payload &&
        typeof payload === "object" &&
        "statusCode" in payload &&
        typeof (payload as { statusCode?: unknown }).statusCode === "number" &&
        "message" in payload &&
        typeof (payload as { message?: unknown }).message === "string"
      ) {
        const statusCode = (payload as { statusCode: number }).statusCode;
        const message = (payload as { message: string }).message;
        return wrapError(statusCode, message, message);
      }
      return wrapError(reply.statusCode, "Request failed", "Request failed");
    }

    if (reply.statusCode === 204) {
      reply.code(200);
    }

    reply.type("application/json; charset=utf-8");
    return wrapSuccess(payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const err = error as FastifyError & {
      validation?: unknown;
      statusCode?: number;
      code?: string;
      message: string;
    };

    request.log.error({ err }, "Request failed");

    const sendError = (
      statusCode: number,
      userMessage: string,
      developerMessage?: string
    ) => {
      const safeStatus =
        statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
      const payload = wrapError(safeStatus, userMessage, developerMessage);

      if (reply.sent) {
        return;
      }

      reply
        .status(safeStatus)
        .type("application/json; charset=utf-8")
        .send(payload);
    };

    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));
      sendError(400, "Validation failed", JSON.stringify(issues));
      return;
    }

    if (err.validation) {
      const developerMessage = (() => {
        try {
          return JSON.stringify(err.validation);
        } catch {
          return String(err.message ?? "Validation failed");
        }
      })();
      sendError(400, "Validation failed", developerMessage);
      return;
    }

    if (err.statusCode === 401 || err.code === "FST_JWT_AUTHORIZATION") {
      sendError(401, "Authentication required", err.message);
      return;
    }

    if (err.statusCode === 403) {
      sendError(403, "Insufficient permissions", err.message);
      return;
    }

    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      sendError(err.statusCode, err.message, err.message);
      return;
    }

    if (err.statusCode && err.statusCode >= 500 && err.statusCode <= 599) {
      const developerMessage = `${err.message ?? "Internal failure"} (correlationId=${request.correlationId})`;
      sendError(err.statusCode, "Something went wrong", developerMessage);
      return;
    }

    const developerMessage = `${err.message ?? "Internal failure"} (correlationId=${request.correlationId})`;
    sendError(500, "Unexpected error occurred", developerMessage);
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", ...getCdnHosts()],
        mediaSrc: ["'self'", ...getCdnHosts()],
        connectSrc: ["'self'", ...getCdnHosts()],
        // Prevent forcing http subresources to https on environments
        // that don't terminate TLS at the Ingress yet (e.g. dev via IP).
        // Without this, Swagger UI assets under /docs/static fail to load.
        upgradeInsecureRequests: null,
      },
    },
    hsts: {
      maxAge: 60 * 60 * 24 * 365,
      includeSubDomains: true,
      preload: false,
    },
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
    frameguard: {
      action: "deny",
    },
  });

  const allowedOrigins = getCorsOrigins();
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.length === 0) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("Origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Request-ID",
      "X-Correlation-ID",
    ],
  });

  app.addHook("preHandler", async (request) => {
    request.log = request.log.child({ correlationId: request.correlationId });
  });

  await app.register(formbody);

  // Must be registered before routes so we can set per-route body limits.
  app.addHook("onRoute", (routeOptions) => {
    const context = routeOptions.config as
      | (FastifyContextConfig & {
        security?: { bodyLimit?: number };
      })
      | undefined;
    const limit = context?.security?.bodyLimit;
    if (typeof limit === "number" && limit > 0) {
      routeOptions.bodyLimit = limit;
    }
  });

  await app.register(tracingPlugin);
  await app.register(redisPlugin);
  await app.register(auditPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(uploadRoutes, { prefix: "/api/v1/upload" });
  await app.register(contentRoutes, { prefix: "/api/v1/content" });
  // Engagement routes registered via plugin
  await app.register(engagementRoutes, { prefix: "/api/v1/engagement" });

  await app.register(searchRoutes, { prefix: "/api/v1/search" });
  await app.register(streamingRoutes, { prefix: "/api/v1/streams" });

  app.get(
    "/health/live",
    {
      config: {
        auth: { public: true },
        rateLimit: false,
        gatewayRateLimit: { skip: true },
        envelope: { disabled: true },
      },
    },
    async () => ({ status: "ok" })
  );

  app.get(
    "/health/ready",
    {
      config: {
        auth: { public: true },
        rateLimit: false,
        gatewayRateLimit: { skip: true },
        envelope: { disabled: true },
      },
    },
    async () => ({ status: "ready" })
  );

  await app.register(replyFrom);

  await app.register(swaggerPlugin);
  await app.register(proxyRoutes);



  return app;
}
