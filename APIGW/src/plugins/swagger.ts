import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type {
  FastifyReply,
  FastifyRequest,
  FastifyContextConfig,
} from "fastify";
import "@fastify/swagger";
import { getGatewayServiceDocuments } from "../config/openapi";
import { mergeOpenApiDocuments } from "../utils/swagger-merge";

function buildAggregatedDocument() {
  const documents = getGatewayServiceDocuments();
  return mergeOpenApiDocuments(documents);
}

export default fp(async function swaggerPlugin(fastify) {
  const aggregatedDocument = buildAggregatedDocument();

  await fastify.register(swagger, {
    mode: "static",
    specification: {
      document: aggregatedDocument,
    },
  });

  const aggregatedJsonRoute = "/docs/catalog.json";

  fastify.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url) {
      return;
    }
    if (routeOptions.url.startsWith("/docs")) {
      const updatedConfig = (routeOptions.config as
        | (FastifyContextConfig & {
            envelope?: { disabled?: boolean };
            rateLimit?: boolean;
          })
        | undefined) ?? {
        auth: undefined,
        gatewayRateLimit: undefined,
        rateLimit: undefined,
        envelope: undefined,
      };

      updatedConfig.auth = { ...(updatedConfig.auth ?? {}), public: true };
      updatedConfig.gatewayRateLimit = {
        ...(updatedConfig.gatewayRateLimit ?? {}),
        skip: true,
      };
      updatedConfig.rateLimit = false;
      updatedConfig.envelope = {
        ...(updatedConfig.envelope ?? {}),
        disabled: true,
      };

      routeOptions.config = updatedConfig;
    }
  });

  fastify.get(aggregatedJsonRoute, {
    config: {
      auth: { public: true },
      rateLimit: false,
      gatewayRateLimit: { skip: true },
      envelope: { disabled: true },
    },
    handler: async (_request, reply) => {
      reply.type("application/json; charset=utf-8");
      return aggregatedDocument;
    },
  });

  await fastify.register(swaggerUI, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      url: aggregatedJsonRoute,
    },
    uiHooks: {
      onRequest: async (_request: FastifyRequest, _reply: FastifyReply) => {
      },
    },
    transformSpecification: () => aggregatedDocument,
    transformSpecificationClone: false,
  });
});
