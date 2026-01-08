import pino, { type Logger } from "pino";

interface AnalyticsExporterOptions {
  endpointUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
}

interface AnalyticsEnvelope {
  event: string;
  payload: Record<string, unknown>;
  emittedAt: string;
}

export class AnalyticsExporter {
  private readonly endpointUrl?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: AnalyticsExporterOptions) {
    this.endpointUrl = options.endpointUrl;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger ?? pino({ name: "analytics-exporter" });
  }

  async emit(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.endpointUrl) {
      this.logger.debug({ event }, "Analytics export disabled");
      return;
    }
    const envelope: AnalyticsEnvelope = {
      event,
      payload,
      emittedAt: new Date().toISOString(),
    };
    await this.post(envelope);
  }

  private async post(body: AnalyticsEnvelope) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpointUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Analytics export failed (${response.status}): ${text}`
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to export analytics event");
    } finally {
      clearTimeout(timeout);
    }
  }
}
