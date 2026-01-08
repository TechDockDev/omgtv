# Operational Runbooks

## Catalog Rollback

1. Identify the impacted entity via `catalog.updated` stream or admin audit logs (`CatalogService` stores `updatedByAdminId`).
2. Use `POST /v1/admin/catalog/episodes/{id}/status` with payload `{ "status": "ARCHIVED" }` to stop exposure immediately.
3. Rehydrate prior metadata using database point-in-time restore or Prisma migration rollback.
4. Warm caches by invoking:
   - `GET /v1/catalog/series/{slug}`
   - `GET /v1/catalog/feed?viewerId=<test>`
5. Verify absence in SearchService (listening to `catalog.updated`). If stale documents remain, request a manual reindex with the emitted `entityId`.

## Emergency Unpublish

1. Call `POST /v1/admin/catalog/episodes/{id}/status` with `{ "status": "ARCHIVED" }`.
2. Flush Redis keys:
   - `catalog:feed:*`
   - `catalog:series:<slug>`
   - `catalog:related:<slug>`
3. Notify API Gateway to purge CDN manifests linked to the episode (invalidate by `manifestUrl`).
4. Confirm viewer feed returns 500 for the affected content until data quality checks pass.

## Cache Flush Procedure

1. Use Redis CLI or automation to delete keys found in `content_cache_events_total` (labels provide the namespace).
2. Trigger warm-up by hitting:
   - `GET /v1/catalog/feed?viewerId=sanity`
   - `GET /v1/catalog/series/{slug}` for top properties.
3. Monitor `X-Cache` header via API Gateway; it should flip to `hit` after warm-up.
4. Ensure metrics `content_cache_events_total{cache_event="miss"}` returns to baseline within 10 minutes.
