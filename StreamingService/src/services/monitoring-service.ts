import type { Logger } from "pino";
import { OvenMediaEngineClient } from "../clients/ome-client";
import type { MetricsRegistry } from "./metrics-registry";
import type { AnalyticsExporter } from "../observability/analytics-exporter";
import type { CdnControlClient } from "../clients/cdn-client";

export class MonitoringService {
  constructor(
    private readonly omeClient: OvenMediaEngineClient,
    private readonly metrics: MetricsRegistry,
    private readonly cdnClient: CdnControlClient,
    private readonly analytics: AnalyticsExporter,
    private readonly logger: Logger
  ) {}

  async collectAndPublish(): Promise<void> {
    await Promise.allSettled([
      this.collectOmeStats(),
      this.validateMultiClusterRouting(),
    ]);
  }

  private async collectOmeStats() {
    try {
      const stats = await this.omeClient.getRealtimeStats();
      this.metrics.resetRealtimeStats();
      for (const channel of stats.channels) {
        this.metrics.recordChannelLoad(
          channel.channelId,
          channel.viewers,
          channel.avgBitrateKbps
        );
        this.metrics.recordBufferEvents(
          channel.channelId,
          channel.bufferEventsPerMin
        );
      }
      await this.analytics.emit("ome.realtime.stats", {
        sampledAt: stats.sampledAt,
        channelCount: stats.channels.length,
        channels: stats.channels,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to collect OME stats");
    }
  }

  private async validateMultiClusterRouting() {
    try {
      const status = await this.cdnClient.validateTrafficDirector();
      if (!status) {
        return;
      }
      this.metrics.recordTrafficDirector(status.cluster, status.healthy);
      await this.analytics.emit("cdn.multi_cluster", {
        cluster: status.cluster,
        healthy: status.healthy,
        validatedAt: status.validatedAt,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Traffic Director validation failed");
    }
  }
}
