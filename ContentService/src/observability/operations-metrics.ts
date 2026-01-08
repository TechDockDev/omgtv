import { metrics, type ObservableResult } from "@opentelemetry/api";
import { CatalogRepository } from "../repositories/catalog-repository";

const meter = metrics.getMeter("content-service");

export type OperationsMetricsOptions = {
  lookbackDays?: number;
};

export class OperationsMetrics {
  private readonly repo: CatalogRepository;
  private readonly lookbackDays: number;
  private readonly unpublishedGauge = meter.createObservableGauge(
    "content_unpublished_entities",
    {
      description: "Number of unpublished entities awaiting moderation or publish",
    }
  );
  private readonly unpublishedCallback = async (
    observableResult: ObservableResult
  ) => {
    const counts = await this.repo.countUnpublishedContent();
    observableResult.observe(counts.series, { entity: "series" });
    observableResult.observe(counts.seasons, { entity: "season" });
    observableResult.observe(counts.episodes, { entity: "episode" });
    observableResult.observe(counts.assetsAwaiting, {
      entity: "media_asset",
    });
  };
  private readonly scheduledGauge = meter.createObservableGauge(
    "content_scheduled_releases_total",
    {
      description: "Upcoming scheduled releases grouped by day horizon",
    }
  );
  private readonly scheduledCallback = async (
    observableResult: ObservableResult
  ) => {
    const counts = await this.repo.countScheduledReleases();
    observableResult.observe(counts.next24Hours, { horizon: "24h" });
    observableResult.observe(counts.next7Days, { horizon: "7d" });
    observableResult.observe(counts.future, { horizon: "beyond" });
  };
  private readonly ingestionGauge = meter.createObservableGauge(
    "content_ingestion_sla_seconds",
    {
      description:
        "Ingestion latency benchmarks (average/p95) from upload to readiness",
      unit: "s",
    }
  );
  private readonly ingestionCallback = async (
    observableResult: ObservableResult
  ) => {
    const stats = await this.repo.getIngestionLatencyStats(
      this.lookbackDays
    );
    if (stats.averageSeconds !== null) {
      observableResult.observe(stats.averageSeconds, { percentile: "avg" });
    }
    if (stats.p95Seconds !== null) {
      observableResult.observe(stats.p95Seconds, { percentile: "p95" });
    }
  };

  constructor(
    repo?: CatalogRepository,
    options: OperationsMetricsOptions = {}
  ) {
    this.repo = repo ?? new CatalogRepository();
    this.lookbackDays = options.lookbackDays ?? 7;

    this.unpublishedGauge.addCallback(this.unpublishedCallback);
    this.scheduledGauge.addCallback(this.scheduledCallback);
    this.ingestionGauge.addCallback(this.ingestionCallback);
  }

  shutdown() {
    this.unpublishedGauge.removeCallback(this.unpublishedCallback);
    this.scheduledGauge.removeCallback(this.scheduledCallback);
    this.ingestionGauge.removeCallback(this.ingestionCallback);
  }
}
