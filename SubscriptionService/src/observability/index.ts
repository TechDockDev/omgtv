import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { loadConfig } from "../config";

let sdk: NodeSDK | undefined;

export async function startObservability() {
  const config = loadConfig();

  const traceExporter = config.OTEL_TRACES_ENDPOINT
    ? new OTLPTraceExporter({ url: config.OTEL_TRACES_ENDPOINT })
    : undefined;
  const metricExporter = config.OTEL_METRICS_ENDPOINT
    ? new OTLPMetricExporter({ url: config.OTEL_METRICS_ENDPOINT })
    : undefined;

  type NodeMetricReader = NonNullable<
    ConstructorParameters<typeof NodeSDK>[0]
  >["metricReader"];

  const metricReader: NodeMetricReader | undefined = metricExporter
    ? (new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.OTEL_METRICS_EXPORT_INTERVAL_MS,
      }) as unknown as NodeMetricReader)
    : undefined;

  sdk = new NodeSDK({
    serviceName: config.OTEL_SERVICE_NAME,
    traceExporter,
    metricReader,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();
}

export async function shutdownObservability() {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}
