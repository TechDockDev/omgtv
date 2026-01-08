# Operations Dashboards

The observability stack exports metrics via OTLP with the following instrument names. Suggested dashboard panels assume a 1-minute scrape interval.

## HTTP Surface

- `content_http_server_requests_total` (counter) grouped by `http_route`, `http_status_class`.
  - **Panel**: Bar/stacked chart showing request mix by route.
- `content_http_server_duration_ms` (histogram) aggregated into P50/P95 latency.
  - **Panel**: Line chart with percentile overlays per major route (feed, series, admin mutations).
- `content_cache_events_total` (counter) by `cache_event`, `cache_key` (`catalog:feed`, `catalog:series`, etc.).
  - **Panel**: Heatmap showing hit/miss ratio. Alert when `miss/hit` ratio > 0.5 for sustained periods.

## Data Quality

- `content_data_quality_issues_total` (counter) grouped by `issue` (`missing_thumbnail`, `missing_manifest`, `orphan_episode`).
  - **Panel**: Single-stat with weekly trend. Configure alert when `missing_thumbnail` spikes.
- Trace events named `catalog.data_quality_issue` annotate spans for root-cause drill downs.

## Catalog Operations

- `content_unpublished_entities` (observable gauge) labelled by `entity`.
  - **Panel**: Table showing counts for `series`, `season`, `episode`, `media_asset` awaiting moderation.
- `content_scheduled_releases_total` (gauge) labelled by `horizon` (`24h`, `7d`, `beyond`).
  - **Panel**: Stacked bar to understand release pipeline.
- `content_ingestion_sla_seconds` (gauge) labelled by `percentile` (`avg`, `p95`).
  - **Panel**: Dual-line chart measuring ingestion SLA against target (< 3600s avg, < 7200s P95).

## Alerts

1. **Data Quality Regression**: Trigger when `content_data_quality_issues_total{issue="missing_thumbnail"}` increases by >5 within 10 minutes.
2. **Cache Inefficiency**: Trigger when `cache_event="miss"` / (`hit` + `miss`) > 0.5 for `catalog:feed` over 15 minutes.
3. **Publish Backlog**: Trigger when `content_unpublished_entities{entity="episode"}` exceeds 50 for 30 minutes.
