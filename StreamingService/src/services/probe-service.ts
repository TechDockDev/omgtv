import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import type { CdnTokenSigner } from "../utils/cdn-signature";
import type { AlertingService } from "./alerting-service";
import type { MetricsRegistry } from "./metrics-registry";
import type { Env } from "../config";
import type { CdnControlClient } from "../clients/cdn-client";
import type { AnalyticsExporter } from "../observability/analytics-exporter";

interface ProbeResult {
  region: string;
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
}

export class ProbeService {
  private readonly regions: string[];
  private readonly timeoutMs: number;

  constructor(
    private readonly repository: ChannelMetadataRepository,
    private readonly signer: CdnTokenSigner,
    private readonly alerting: AlertingService,
    private readonly metrics: MetricsRegistry,
    private readonly cdnClient: CdnControlClient,
    private readonly analytics: AnalyticsExporter,
    config: Env
  ) {
    this.regions = config.CDN_PROBE_REGIONS.split(",").map((region) =>
      region.trim()
    );
    this.timeoutMs = config.PROBE_TIMEOUT_MS;
  }

  async runManifestProbes(contentId: string): Promise<ProbeResult[]> {
    const channel = await this.repository.findByContentId(contentId);
    if (!channel) {
      throw new Error("Stream not found");
    }

    const results: ProbeResult[] = [];
    for (const region of this.regions) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const start = performance.now();
      try {
        const signed = this.signer.signManifest({
          channel,
          ttlSeconds: 60,
          sessionId: randomUUID(),
          preferFailover:
            region.startsWith("alt-") && Boolean(channel.ingestRegion),
        });
        const response = await fetch(signed.url, {
          method: "GET",
          headers: {
            "x-probe-region": region,
          },
          signal: controller.signal,
        });
        results.push({
          region,
          success: response.ok,
          statusCode: response.status,
          latencyMs: Math.round(performance.now() - start),
        });
        this.metrics.recordProbe(region, response.ok ? "success" : "failure");
        if (!response.ok) {
          await this.alerting.probeFailure(contentId, region, response.status);
        }
      } catch (error) {
        results.push({
          region,
          success: false,
        });
        this.metrics.recordProbe(region, "failure");
        await this.alerting.probeFailure(contentId, region, error);
      } finally {
        clearTimeout(timeout);
      }
    }
    await this.evaluateFailover(
      channel.manifestPath,
      channel.ingestRegion,
      results
    );
    await this.analytics.emit("stream.probe.results", {
      contentId,
      results,
      executedAt: new Date().toISOString(),
    });
    return results;
  }

  private async evaluateFailover(
    manifestPath: string,
    ingestRegion: string | undefined,
    results: ProbeResult[]
  ) {
    if (!results.length) {
      return;
    }
    const failures = results.filter((result) => !result.success);
    if (!failures.length) {
      return;
    }
    const failureRatio = failures.length / results.length;
    if (failureRatio < 0.5) {
      return;
    }
    await this.cdnClient.promoteFailover(manifestPath, ingestRegion);
  }
}
