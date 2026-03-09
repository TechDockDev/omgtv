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
import adminRoutes from "./routes/admin";
import customerRoutes from "./routes/customer";
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

  // Custom parser to capture raw body for Razorpay webhooks (required for signature verification)
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    try {
      if (request.url.includes("/webhooks/razorpay")) {
        // Store raw body for signature verification
        (request as any).rawBody = body;
      }
      const json = JSON.parse(body.toString());
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(serviceAuthPlugin);
  await app.register(internalRoutes, { prefix: "/internal" });

  const externalBase = "/api/v1/subscription";
  await app.register(adminRoutes, { prefix: `${externalBase}/admin` });
  await app.register(customerRoutes, { prefix: externalBase });

  // Register webhooks
  await app.register(import("./routes/webhooks"), { prefix: `${externalBase}/webhooks` });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
