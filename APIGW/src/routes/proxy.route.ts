import fp from "fastify-plugin";
import type { IncomingHttpHeaders } from "http";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyContextConfig,
} from "fastify";
import "@fastify/reply-from";
import { loadConfig } from "../config";
import { getServiceRegistry } from "../config/services";
import { ensureLeadingSlash, joinUrlSegments } from "../utils/path";
import type { GatewayRole } from "../types";

const SUPPORTED_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

type ProxyVariant = {
  readonly gatewayPath: string;
  readonly forwardPrefix?: string;
  readonly public: boolean;
  readonly rateLimitPolicy?: "anonymous" | "authenticated" | "admin";
  readonly requiredRole?: GatewayRole;
  readonly methods?: readonly SupportedMethod[];
};

interface WildcardParams {
  "*"?: string;
}

function buildTargetUrl(
  serviceTarget: string,
  internalBasePath: string | undefined,
  forwardPrefix: string | undefined,
  wildcard: string | undefined,
  originalUrl: string
): string {
  const upstream = new URL(serviceTarget);

  const suffix = joinUrlSegments(forwardPrefix, wildcard);
  const combinedPath = joinUrlSegments(
    upstream.pathname,
    internalBasePath,
    suffix
  );

  upstream.pathname = ensureLeadingSlash(combinedPath);

  const queryIndex = originalUrl.indexOf("?");
  if (queryIndex !== -1) {
    upstream.search = originalUrl.substring(queryIndex);
  }

  return upstream.toString();
}

async function forwardRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  serviceTarget: string,
  internalBasePath: string | undefined,
  forwardPrefix: string | undefined
) {
  const config = loadConfig();
  const params = request.params as WildcardParams;
  const wildcard = params["*"] ?? "";
  const targetUrl = buildTargetUrl(
    serviceTarget,
    internalBasePath,
    forwardPrefix,
    wildcard,
    request.raw.url ?? request.url
  );

  await reply.from(targetUrl, {
    rewriteRequestHeaders: (_forwardRequest, headers: IncomingHttpHeaders) => {
      const nextHeaders: IncomingHttpHeaders = { ...headers };
      nextHeaders["x-forwarded-for"] = request.ip;
      nextHeaders["x-correlation-id"] = request.correlationId;
      if (request.user) {
        nextHeaders["x-user-id"] = request.user.id;
        nextHeaders["x-user-roles"] = request.user.roles.join(",");
        nextHeaders["x-user-type"] = request.user.userType;
        if (request.user.languageId) {
          nextHeaders["x-user-language-id"] = request.user.languageId;
        }
      }
      if (config.SERVICE_AUTH_TOKEN) {
        const originalAuthorization = nextHeaders.authorization;
        if (originalAuthorization) {
          nextHeaders["x-gateway-original-authorization"] = Array.isArray(
            originalAuthorization
          )
            ? originalAuthorization[0]
            : originalAuthorization;
        }

        nextHeaders["x-service-token"] = config.SERVICE_AUTH_TOKEN;
        nextHeaders.authorization = `Bearer ${config.SERVICE_AUTH_TOKEN}`;
      }
      return nextHeaders;
    },
  });
}

function registerVariant(
  fastify: FastifyInstance,
  service: ReturnType<typeof getServiceRegistry>[number],
  variant: ProxyVariant
) {
  const methods = (variant.methods ??
    SUPPORTED_METHODS) as readonly SupportedMethod[];
  const baseConfig = {
    auth: { public: variant.public },
    rateLimitPolicy: variant.rateLimitPolicy,
  } as const;
  const baseGatewayRateLimit = variant.rateLimitPolicy
    ? undefined
    : { skip: variant.public };
  const requiresAdminAccess =
    !variant.public &&
    (service.access === "admin" || variant.rateLimitPolicy === "admin");

  const authorizeHandler = variant.requiredRole
    ? fastify.authorize([variant.requiredRole])
    : undefined;

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    await forwardRequest(
      request,
      reply,
      service.target,
      service.internalBasePath,
      variant.forwardPrefix
    );
  };

  for (const method of methods) {
    const config = {
      ...baseConfig,
      gatewayRateLimit: baseGatewayRateLimit,
    };

    const preHandlers: Array<
      (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    > = [];

    if (requiresAdminAccess) {
      preHandlers.push(async (request, reply) => {
        const routeConfig = request.routeOptions.config as
          | (FastifyContextConfig & {
              accessControl?: { allowAnyAuthenticated?: boolean };
            })
          | undefined;

        if (routeConfig?.accessControl?.allowAnyAuthenticated) {
          return;
        }

        if (!request.user || request.user.userType !== "ADMIN") {
          reply.code(403);
          throw new Error("Admin token required");
        }
      });
    }

    if (authorizeHandler) {
      const wrappedAuthorize = authorizeHandler;
      preHandlers.push(async (request, reply) => {
        const routeConfig = request.routeOptions.config as
          | (FastifyContextConfig & {
              accessControl?: { allowAnyAuthenticated?: boolean };
            })
          | undefined;

        if (routeConfig?.accessControl?.allowAnyAuthenticated) {
          return;
        }

        await wrappedAuthorize(request, reply);
      });
    }

    fastify.route({
      method,
      url: variant.gatewayPath,
      config,
      preHandler: preHandlers.length ? preHandlers : undefined,
      handler,
    });

    fastify.route({
      method,
      url: `${variant.gatewayPath}/*`,
      config: { ...config },
      preHandler: preHandlers.length ? preHandlers : undefined,
      handler,
    });
  }
}

export default fp(async function proxyRoutes(fastify) {
  const allowAnyAuthenticatedPaths = new Set([
    "/api/v1/content/admin/catalog/tags",
    "/api/v1/content/admin/catalog/tags/*",
  ]);

  fastify.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url) {
      return;
    }

    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : routeOptions.method
        ? [routeOptions.method]
        : [];

    if (
      methods.includes("GET") &&
      allowAnyAuthenticatedPaths.has(routeOptions.url)
    ) {
      const existingConfig = (routeOptions.config ??
        {}) as FastifyContextConfig & {
        accessControl?: { allowAnyAuthenticated?: boolean };
      };

      routeOptions.config = {
        ...existingConfig,
        accessControl: {
          ...(existingConfig.accessControl ?? {}),
          allowAnyAuthenticated: true,
        },
      };
    }
  });

  const services = getServiceRegistry();

  for (const service of services) {
    if (service.exposeViaProxy === false) {
      continue;
    }

    const defaultPolicy =
      service.rateLimitPolicy ??
      (service.access === "admin"
        ? "admin"
        : service.access === "authenticated"
          ? "authenticated"
          : "anonymous");

    if (service.publicPrefixes && service.publicPrefixes.length > 0) {
      for (const prefix of service.publicPrefixes) {
        const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
        registerVariant(fastify, service, {
          gatewayPath: `${service.basePath}${normalizedPrefix}`,
          forwardPrefix: normalizedPrefix,
          public: true,
          rateLimitPolicy: "anonymous",
        });
      }
    }

    if (service.adminPrefixes && service.adminPrefixes.length > 0) {
      for (const prefix of service.adminPrefixes) {
        const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
        registerVariant(fastify, service, {
          gatewayPath: `${service.basePath}${normalizedPrefix}`,
          forwardPrefix: normalizedPrefix,
          public: false,
          rateLimitPolicy: "admin",
        });
      }
    }

    registerVariant(fastify, service, {
      gatewayPath: service.basePath,
      forwardPrefix: undefined,
      public: service.access === "public",
      rateLimitPolicy: defaultPolicy,
    });
  }
});
