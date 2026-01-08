import { createApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const config = loadConfig();
  const app = await createApp();

  const stop = async () => {
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await app.listen({ port: config.SERVER_PORT, host: config.SERVER_HOST });
    app.log.info(
      {
        event: "server_started",
        port: config.SERVER_PORT,
        host: config.SERVER_HOST,
        env: config.NODE_ENV,
      },
      "PocketLOL API Gateway listening"
    );
  } catch (error) {
    app.log.fatal({ err: error }, "Failed to start PocketLOL API Gateway");
    process.exit(1);
  }
}

main();

export { main };
