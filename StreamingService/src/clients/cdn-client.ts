import type { Logger } from "pino";
import type { AnalyticsExporter } from "../observability/analytics-exporter";

interface CdnControlClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  logger: Logger;
  analytics?: AnalyticsExporter;
}

interface TrafficDirectorStatus {
  cluster: string;
  healthy: boolean;
  validatedAt: string;
}

export class CdnControlClient {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly analytics?: AnalyticsExporter;

  constructor(options: CdnControlClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger.child({ module: "cdn-client" });
    this.analytics = options.analytics;
  }

  async purge(manifestPath: string): Promise<void> {
    if (!this.baseUrl) {
      this.logger.warn(
        { manifestPath },
        "CDN control endpoint not configured; skipping purge"
      );
      return;
    }
    await this.post("/purge", { path: manifestPath });
    this.logger.info({ manifestPath }, "Requested CDN purge");
    await this.analytics?.emit("cdn.purge", {
      manifestPath,
      issuedAt: new Date().toISOString(),
    });
  }

  async warmup(manifestUrl: string): Promise<void> {
    if (!this.baseUrl) {
      return;
    }
    await this.post("/warmup", { url: manifestUrl });
    await this.analytics?.emit("cdn.warmup", {
      manifestUrl,
      issuedAt: new Date().toISOString(),
    });
  }

  async promoteFailover(
    manifestPath: string,
    ingestRegion?: string
  ): Promise<void> {
    if (!this.baseUrl) {
      this.logger.warn("CDN control endpoint missing; cannot promote failover");
      return;
    }
    await this.post("/failover", { path: manifestPath, ingestRegion });
    this.logger.warn({ manifestPath, ingestRegion }, "Requested CDN failover");
    await this.analytics?.emit("cdn.failover", {
      manifestPath,
      ingestRegion,
      issuedAt: new Date().toISOString(),
    });
  }

  async validateTrafficDirector(): Promise<TrafficDirectorStatus | undefined> {
    if (!this.baseUrl) {
      return undefined;
    }
    const status = await this.post<TrafficDirectorStatus>(
      "/traffic-director/validate",
      {}
    );
    return status;
  }

  private async post<T = unknown>(
    path: string,
    body: unknown
  ): Promise<T | undefined> {
    if (!this.baseUrl) {
      return undefined;
    }
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.apiKey) {
        headers.authorization = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.text();
        this.logger.warn(
          { statusCode: response.status, payload },
          "CDN control request failed"
        );
        throw new Error(`CDN control request failed (${response.status})`);
      }
      const parsed = (await response.json().catch(() => undefined)) as
        | T
        | undefined;
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}
