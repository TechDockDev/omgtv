# Outbound Integrations

## Pub/Sub: `catalog.updated`

- **Emitter**: `RedisCatalogEventsPublisher` (`src/services/catalog-events.ts`).
- **Channel**: Redis Stream defined by `CATALOG_EVENT_STREAM_KEY` (defaults to `catalog:events`).
- **Event shape**:
  - `type`: always `catalog.updated`.
  - `entity`: `category|series|season|episode|mediaAsset`.
  - `entityId`: UUID.
  - `operation`: `create|update|delete`.
  - `timestamp`: ISO8601.
  - `payload`: Slim delta describing changed fields (e.g., `status`, `slug`).
- **Consumers**: SearchService (reindex), EngagementService (popularity adjustments), Analytics pipelines.
- **Delivery**: At-least-once using Redis consumer groups. Consumers should ack the entry ID after persistence.

## gRPC: `ContentService.CatalogSnapshot`

Although the proto currently exposes `GetVideoMetadata`, the service hosts the gRPC runtime on `GRPC_BIND_ADDRESS`. The planned integration for SearchService is a server-streaming method defined in `proto/content.proto` (pending update):

```
rpc CatalogSnapshot(CatalogSnapshotRequest) returns (stream CatalogSnapshotChunk);
```

### Proposed message shape

- `CatalogSnapshotRequest`
  - `cursor`: optional string representing last processed event ID.
  - `limit`: chunk size hint (default 100).
- `CatalogSnapshotChunk`
  - `items[]`: flattened series + episodic payloads (mirrors `CatalogFeedItem`).
  - `nextCursor`: cursor for the following call (null when finished).

**Transport expectations**

- Mutual TLS between ContentService and SearchService (handled by Envoy in the deployment stack).
- Authorization via the same `SERVICE_AUTH_TOKEN` header used for unary methods.

## API Gateway Manifest Linkage

- Viewer endpoints surface `playback.manifestUrl` and `playback.variants[*].label/bitrate`.
- Gateway attaches request-scoped signed URLs before forwarding to client apps.
- Contracts:
  - `manifestUrl` must always be HTTPS and point to the StreamingService CDN bucket.
  - When a manifest is absent, ContentService returns 500 to the viewer, causing the gateway to bubble an error and trigger rollback automation.

## Cache Invalidation Hooks

- Redis keys follow `catalog:{type}:{identifier}` conventions. `recordCacheEvent` metrics expose `cache_event=set|hit|miss|invalidate` for dashboards.
- When admin APIs mutate catalog entities, `CatalogService` raises `catalog.updated` events so downstream cache warmers (e.g., API Gateway) can purge stale manifests.
