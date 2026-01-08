import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("content-service");

const httpDurationHistogram = meter.createHistogram(
  "content_http_server_duration_ms",
  {
    description: "Latency for incoming HTTP requests handled by ContentService",
    unit: "ms",
  }
);

const httpRequestCounter = meter.createCounter(
  "content_http_server_requests_total",
  {
    description: "Total HTTP requests handled by ContentService",
  }
);

const cacheEventCounter = meter.createCounter("content_cache_events_total", {
  description: "Cache layer events (hit/miss/set) for ContentService",
});

const dataQualityCounter = meter.createCounter(
  "content_data_quality_issues_total",
  {
    description:
      "Data quality issues detected while serving catalog content (missing assets, orphan nodes, etc.)",
  }
);

export type HttpMetricAttributes = {
  method: string;
  route: string;
  statusClass: string;
  source?: string;
};

export function recordHttpRequest(
  durationMs: number,
  attributes: HttpMetricAttributes
) {
  httpDurationHistogram.record(durationMs, {
    http_method: attributes.method,
    http_route: attributes.route,
    http_status_class: attributes.statusClass,
    http_source: attributes.source,
  });
  httpRequestCounter.add(1, {
    http_method: attributes.method,
    http_route: attributes.route,
    http_status_class: attributes.statusClass,
    http_source: attributes.source,
  });
}

export type CacheEvent = "hit" | "miss" | "set" | "invalidate";

export function recordCacheEvent(event: CacheEvent, key: string) {
  cacheEventCounter.add(1, {
    cache_event: event,
    cache_key: key,
  });
}

export type DataQualityIssueKind =
  | "missing_thumbnail"
  | "missing_manifest"
  | "orphan_episode"
  | "missing_series_category";

export function recordDataQualityIssue(
  issue: DataQualityIssueKind,
  attributes: Record<string, string | undefined>,
  severity: "warning" | "error"
) {
  dataQualityCounter.add(1, {
    issue,
    severity,
    ...attributes,
  });
}
