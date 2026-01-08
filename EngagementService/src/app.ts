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
import internalRoutes from "./routes/internal";

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
  await app.register(serviceAuthPlugin);
  await app.register(internalRoutes, { prefix: "/internal" });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof Error && error.message.startsWith("UNAUTHORIZED:")) {
      request.log.warn({ err: error }, "Unauthorized request");
      return reply.unauthorized(
        error.message.replace("UNAUTHORIZED:", "").trim()
      );
    }
    return reply.send(error);
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
