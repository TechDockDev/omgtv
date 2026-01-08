import pino, { type Logger } from "pino";
import type { ChannelMetadata } from "../types/channel";
import type { AnalyticsExporter } from "../observability/analytics-exporter";
import { withExponentialBackoff } from "../utils/retry";

interface NotificationPublisherOptions {
  contentServiceUrl?: string;
  cacheWarmupUrl?: string;
  observabilityUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
  analyticsExporter?: AnalyticsExporter;
}

export interface PlaybackReadyNotification {
  metadata: ChannelMetadata;
  manifestUrl: string;
  expiresAt: string;
}

export class NotificationPublisher {
  private readonly contentServiceUrl?: string;
  private readonly cacheWarmupUrl?: string;
  private readonly observabilityUrl?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly analytics?: AnalyticsExporter;

  constructor(options: NotificationPublisherOptions) {
    this.contentServiceUrl = options.contentServiceUrl;
    this.cacheWarmupUrl = options.cacheWarmupUrl;
    this.observabilityUrl = options.observabilityUrl;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger ?? pino({ name: "notification-publisher" });
    this.analytics = options.analyticsExporter;
  }

  async publishPlaybackReady(
    payload: PlaybackReadyNotification
  ): Promise<void> {
    await Promise.all([
      this.notifyContentService(payload),
      this.notifyApiGateway(payload),
      this.emitObservabilitySignal(payload),
      this.analytics?.emit("stream.provisioned", {
        contentId: payload.metadata.contentId,
        manifestPath: payload.metadata.manifestPath,
        retries: payload.metadata.retries,
        emittedAt: new Date().toISOString(),
      }) ?? Promise.resolve(),
    ]);
  }

  private async notifyContentService(payload: PlaybackReadyNotification) {
    if (!this.contentServiceUrl) {
      this.logger.debug(
        { contentId: payload.metadata.contentId },
        "ContentService callback disabled"
      );
      return;
    }
    await this.postJson(this.contentServiceUrl, {
      contentId: payload.metadata.contentId,
      manifestUrl: payload.manifestUrl,
      channelId: payload.metadata.channelId,
      expiresAt: payload.expiresAt,
      checksum: payload.metadata.checksum,
    });
  }

  private async notifyApiGateway(payload: PlaybackReadyNotification) {
    if (!this.cacheWarmupUrl) {
      this.logger.debug(
        { contentId: payload.metadata.contentId },
        "API Gateway warmup disabled"
      );
      return;
    }
    await this.postJson(this.cacheWarmupUrl, {
      manifestUrl: payload.manifestUrl,
      cacheKey: payload.metadata.cacheKey,
    });
  }

  private async emitObservabilitySignal(payload: PlaybackReadyNotification) {
    if (!this.observabilityUrl) {
      this.logger.debug(
        { contentId: payload.metadata.contentId },
        "Observability export disabled"
      );
      return;
    }
    await this.postJson(this.observabilityUrl, {
      event: "stream.provisioned",
      contentId: payload.metadata.contentId,
      manifestPath: payload.metadata.manifestPath,
      retries: payload.metadata.retries,
      occurredAt: new Date().toISOString(),
    });
  }

  private async postJson(url: string, body: unknown) {
    await withExponentialBackoff(() => this.performPost(url, body), {
      retries: 3,
      onRetry: (error, attempt) =>
        this.logger.warn({ url, err: error, attempt }, "Notification retry"),
    });
  }

  private async performPost(url: string, body: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Notification POST failed (${response.status}): ${text}`
        );
      }
    } catch (error) {
      this.logger.warn({ url, err: error }, "Notification delivery failed");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
