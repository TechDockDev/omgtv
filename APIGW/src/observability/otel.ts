import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config";

let provider: NodeTracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;
let initialized = false;

export async function initializeTelemetry(
  config: AppConfig,
  logger?: FastifyBaseLogger
): Promise<void> {
  if (initialized) {
    return;
  }

  if (!config.ENABLE_TELEMETRY) {
    return;
  }

  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    logger?.warn(
      "Telemetry enabled but OTEL_EXPORTER_OTLP_ENDPOINT is not configured; skipping initialization"
    );
    return;
  }

  diag.setLogger(
    new DiagConsoleLogger(),
    config.NODE_ENV === "development" ? DiagLogLevel.INFO : DiagLogLevel.ERROR
  );

  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = config.SERVICE_NAME;
  }

  const resourceAttributes = new Set(
    (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  const deploymentKey = SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT;
  const deploymentAttr = `${deploymentKey}=${config.NODE_ENV}`;
  if (
    ![...resourceAttributes].some((entry) =>
      entry.startsWith(`${deploymentKey}=`)
    )
  ) {
    resourceAttributes.add(deploymentAttr);
  }

  process.env.OTEL_RESOURCE_ATTRIBUTES = [...resourceAttributes].join(",");

  provider = new NodeTracerProvider();

  (
    provider as unknown as { addSpanProcessor: (processor: unknown) => void }
  ).addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: config.OTEL_EXPORTER_OTLP_ENDPOINT,
      })
    )
  );

  contextManager = new AsyncLocalStorageContextManager().enable();
  provider.register({ contextManager });

  initialized = true;
  logger?.info("OpenTelemetry tracing initialized");
}

export async function shutdownTelemetry(
  logger?: FastifyBaseLogger
): Promise<void> {
  if (!initialized || !provider) {
    return;
  }

  try {
    await provider.shutdown();
    logger?.info("OpenTelemetry tracing shut down");
  } catch (error) {
    logger?.error({ err: error }, "Failed to shutdown telemetry");
  } finally {
    contextManager?.disable();
    provider = undefined;
    contextManager = undefined;
    initialized = false;
  }
}
