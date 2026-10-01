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
import globalResponsePlugin from "./plugins/global-response";
import swaggerPlugin from "./plugins/swagger";
import internalRoutes from "./routes/internal";
import batchRoutes from "./routes/batch";
import clientRoutes from "./routes/client";
import adminRoutes from "./routes/admin";
import audienceRoutes from "./routes/audience";
import audienceAdminRoutes from "./routes/audience-admin";
import { initRealNotifier } from "./services/audience-notifier";
import { getPrismaOptional } from "./lib/prisma";
import { startProgressSyncWorker } from "./workers/progress-sync";
import { startStatsSyncWorker } from "./workers/stats-sync";
import { startUserActionSyncWorker } from "./workers/user-action-sync";

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
  await app.register(swaggerPlugin);
  await app.register(serviceAuthPlugin);
  await app.register(globalResponsePlugin);
  await app.register(internalRoutes, { prefix: "/internal" });
  await app.register(batchRoutes, { prefix: "/internal" });
  await app.register(clientRoutes, { prefix: "/client" });
  await app.register(audienceRoutes, { prefix: "/client/audience" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(audienceAdminRoutes, { prefix: "/admin/audience" });

  app.get("/health", async () => ({ status: "ok" }));

  // Wire up real audience notification sender when the DB is available.
  const prisma = getPrismaOptional();
  if (prisma) initRealNotifier(prisma);

  // Start background workers
  startProgressSyncWorker();
  startStatsSyncWorker();
  startUserActionSyncWorker();

  return app;
}
