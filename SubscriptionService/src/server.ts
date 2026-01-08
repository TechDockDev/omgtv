import { buildApp } from "./app";
import { loadConfig } from "./config";
import { disconnectPrisma } from "./lib/prisma";
import { shutdownObservability, startObservability } from "./observability";
import packageJson from "../package.json";

async function main() {
  const config = loadConfig();

  await startObservability();

  const app = await buildApp();

  try {
    await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
    app.log.info(
      { version: packageJson.version, http: `${config.HTTP_HOST}:${config.HTTP_PORT}` },
      "SubscriptionService ready"
    );
  } catch (error) {
    app.log.error({ err: error }, "Failed to start SubscriptionService");
    await disconnectPrisma();
    await shutdownObservability();
    await app.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "Shutting down SubscriptionService");
    try {
      await disconnectPrisma();
      await shutdownObservability();
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
