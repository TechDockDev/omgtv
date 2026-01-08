import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const app = await buildApp();
  const config = loadConfig();

  try {
    await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
    app.log.info(
      { http: `${config.HTTP_HOST}:${config.HTTP_PORT}` },
      "EngagementService ready"
    );
  } catch (error) {
    app.log.error({ err: error }, "Failed to start EngagementService");
    await app.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "Shutting down EngagementService");
    try {
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
