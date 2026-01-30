import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { loadConfig } from "./config";
import serviceAuthPlugin from "./plugins/service-auth";
import metricsPlugin from "./plugins/metrics";
import globalResponsePlugin from "./plugins/global-response";
import prismaPlugin from "./plugins/prisma";
import pubsubPlugin from "./plugins/pubsub";
import catalogPlugin from "./plugins/catalog";
import mediaReadySubscriber from "./subscribers/media-ready";
import mediaUploadedSubscriber from "./subscribers/media-uploaded";
import cacheInvalidationSubscriber from "./subscribers/cache-invalidator";
import internalRoutes from "./routes/internal";
import adminRoutes from "./routes/admin";
import viewerCatalogRoutes from "./routes/viewer/catalog";
import mobileAppRoutes from "./routes/viewer/mobile";

export async function buildApp() {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
            },
          }
          : undefined,
    },
    trustProxy: true,
    bodyLimit: config.HTTP_BODY_LIMIT,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(cors, { origin: false });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(prismaPlugin);
  await app.register(metricsPlugin);
  await app.register(globalResponsePlugin);
  await app.register(pubsubPlugin);
  await app.register(catalogPlugin);
  await app.register(mediaReadySubscriber);
  await app.register(cacheInvalidationSubscriber);
  // await app.register(mediaUploadedSubscriber); // Replaced by internal HTTP route
  await app.register(serviceAuthPlugin);
  await app.register(internalRoutes, { prefix: "/internal" });

  // Ensure external HTTP surface follows /api/v1/{service}/... convention
  const externalBase = "/api/v1/content";
  await app.register(adminRoutes, { prefix: `${externalBase}/admin` });
  await app.register(viewerCatalogRoutes, {
    prefix: `${externalBase}/catalog`,
  });
  await app.register(mobileAppRoutes, {
    prefix: `${externalBase}/mobile`,
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
