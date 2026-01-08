import type { Logger } from "pino";
import type { AnalyticsExporter } from "../observability/analytics-exporter";

interface AlertingServiceOptions {
  observabilityUrl?: string;
  auditTopic?: string;
  logger: Logger;
  analyticsExporter?: AnalyticsExporter;
}

interface AlertPayload {
  event: string;
  severity: "info" | "warning" | "critical";
  description: string;
  metadata?: Record<string, unknown>;
}

export class AlertingService {
  private readonly observabilityUrl?: string;
  private readonly auditTopic?: string;
  private readonly logger: Logger;
  private readonly analytics?: AnalyticsExporter;

  constructor(options: AlertingServiceOptions) {
    this.observabilityUrl = options.observabilityUrl;
    this.auditTopic = options.auditTopic;
    this.logger = options.logger.child({ module: "alerting" });
    this.analytics = options.analyticsExporter;
  }

  async emit(payload: AlertPayload): Promise<void> {
    this.logger.info({ payload }, "Emitting alert");
    if (this.observabilityUrl) {
      await fetch(this.observabilityUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, auditTopic: this.auditTopic }),
      }).catch((error) => {
        this.logger.warn(
          { error },
          "Failed to deliver alert to observability endpoint"
        );
      });
    }
    await this.analytics?.emit(payload.event, {
      ...payload,
      auditTopic: this.auditTopic,
      emittedAt: new Date().toISOString(),
    });
  }

  ingestFailure(contentId: string, error: unknown) {
    return this.emit({
      event: "stream.ingest.failure",
      severity: "critical",
      description: `Ingest failed for ${contentId}`,
      metadata: { contentId, error: serializeError(error) },
    });
  }

  manifestLatency(contentId: string, latencyMs: number) {
    return this.emit({
      event: "stream.manifest.latency",
      severity: latencyMs > 500 ? "warning" : "info",
      description: `Manifest latency ${latencyMs}ms`,
      metadata: { contentId, latencyMs },
    });
  }

  probeFailure(contentId: string, region: string, error: unknown) {
    return this.emit({
      event: "stream.probe.failure",
      severity: "warning",
      description: `Probe failed for ${contentId} (${region})`,
      metadata: { contentId, region, error: serializeError(error) },
    });
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return error;
}
