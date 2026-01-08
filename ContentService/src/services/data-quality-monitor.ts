import { trace } from "@opentelemetry/api";
import { MediaAssetStatus } from "@prisma/client";
import type { EpisodeWithRelations } from "../repositories/catalog-repository";
import {
  recordDataQualityIssue,
  type DataQualityIssueKind,
} from "../observability/metrics";

export type DataQualityContext = {
  source: string;
  requestId?: string;
};

export type DataQualityIssue = {
  kind: DataQualityIssueKind;
  severity: "warning" | "error";
  message: string;
  attributes: Record<string, string | undefined>;
};

export class CatalogConsistencyError extends Error {
  constructor(public readonly issue: DataQualityIssue) {
    super(issue.message);
    this.name = "CatalogConsistencyError";
  }
}

export class DataQualityMonitor {
  ensureEpisodeConsistency(
    episode: EpisodeWithRelations,
    context: DataQualityContext
  ) {
    const baseAttributes = {
      episodeId: episode.id,
      seriesId: episode.series?.id,
      seasonId: episode.season?.id,
      source: context.source,
    } satisfies Record<string, string | undefined>;

    if (!episode.series) {
      this.fail(
        "orphan_episode",
        "Episode is missing its parent series",
        baseAttributes
      );
    }

    if (
      !episode.defaultThumbnailUrl &&
      !episode.mediaAsset?.defaultThumbnailUrl &&
      !episode.series?.heroImageUrl
    ) {
      this.fail(
        "missing_thumbnail",
        "Episode has no default thumbnail fallback",
        baseAttributes
      );
    }

    if (
      episode.mediaAsset &&
      episode.mediaAsset.status === MediaAssetStatus.READY &&
      !episode.mediaAsset.manifestUrl
    ) {
      this.fail(
        "missing_manifest",
        "Ready media asset is missing playback manifest URL",
        baseAttributes
      );
    }

    if (!episode.series?.category?.id) {
      this.warn(
        "missing_series_category",
        "Series is missing category linkage",
        baseAttributes
      );
    }
  }

  private fail(
    kind: DataQualityIssueKind,
    message: string,
    attributes: Record<string, string | undefined>
  ): never {
    const issue: DataQualityIssue = {
      kind,
      message,
      severity: "error",
      attributes,
    };
    recordDataQualityIssue(kind, attributes, "error");
    this.emitTraceEvent(issue);
    throw new CatalogConsistencyError(issue);
  }

  private warn(
    kind: DataQualityIssueKind,
    message: string,
    attributes: Record<string, string | undefined>
  ) {
    const issue: DataQualityIssue = {
      kind,
      message,
      severity: "warning",
      attributes,
    };
    recordDataQualityIssue(kind, attributes, "warning");
    this.emitTraceEvent(issue);
  }

  private emitTraceEvent(issue: DataQualityIssue) {
    const span = trace.getActiveSpan();
    span?.addEvent("catalog.data_quality_issue", {
      kind: issue.kind,
      severity: issue.severity,
      message: issue.message,
      ...issue.attributes,
    });
  }
}
