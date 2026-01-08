import { buildApp } from "./app";
import { loadConfig } from "./config";
import { startGrpcServer, stopGrpcServer } from "./grpc/server";
import { disconnectPrisma } from "./lib/prisma";
import { startObservability, shutdownObservability } from "./observability";
import { OperationsMetrics } from "./observability/operations-metrics";
import packageJson from "../package.json";

async function main() {
  const config = loadConfig();

  await startObservability({
    serviceName: config.OTEL_SERVICE_NAME,
    serviceVersion: packageJson.version,
    tracesEndpoint: config.OTEL_TRACES_ENDPOINT,
    metricsEndpoint: config.OTEL_METRICS_ENDPOINT,
    metricsExportIntervalMillis: config.OTEL_METRICS_EXPORT_INTERVAL_MS,
  });

  const operationsMetrics = new OperationsMetrics();

  const app = await buildApp();
  let grpcServer: Awaited<ReturnType<typeof startGrpcServer>> | undefined;

  try {
    await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
    grpcServer = await startGrpcServer(app);
    app.log.info(
      { http: `${config.HTTP_HOST}:${config.HTTP_PORT}` },
      "ContentService ready"
    );
  } catch (error) {
    app.log.error({ err: error }, "Failed to start ContentService");
    if (grpcServer) {
      await stopGrpcServer(grpcServer);
    }
    await disconnectPrisma();
    operationsMetrics.shutdown();
    await shutdownObservability();
    await app.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "Shutting down ContentService");
    try {
      if (grpcServer) {
        await stopGrpcServer(grpcServer);
      }
      await disconnectPrisma();
      operationsMetrics.shutdown();
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
