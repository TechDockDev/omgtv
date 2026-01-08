# Ingest & Upstream Event Contracts

This document captures the remaining inbound integrations that the Content Service consumes from the platform. All payloads are JSON encoded with a canonical camelCase style unless stated otherwise. Every topic uses at-least-once delivery semantics, so handlers must be idempotent.

## UploadService → `media.processed`

- **Topic**: `upload.media.processed`
- **Acknowledgement**: HTTP 202 from `/internal/events/media-processed`; retries with exponential backoff when non-2xx.
- **Payload**:
  - `episodeId` (UUID, required): Target ContentService episode.
  - `status` (`PENDING|PROCESSING|READY|FAILED`): Mirrors the `MediaAssetStatus` enum.
  - `sourceUploadId` (string, optional): Upload identifier to support traceability.
  - `streamingAssetId` (string, optional): Identifier supplied by StreamingService.
  - `manifestUrl` (URL, optional): Playback manifest location; required whenever `status` is `READY`.
  - `defaultThumbnailUrl` (URL, optional): Poster image derived from StreamingService if ContentService has not set one explicitly.
  - `variants[]` (array, min 1): Resolution/bitrate ladder. Each entry contains `label`, `width`, `height`, `bitrateKbps`, `codec`, `frameRate`.
  - `occurredAt` (ISO8601, optional): Source event timestamp preserved for tracing.
- **Processing rules**:
  - Events fail fast when thumbnails or manifests are missing; such failures surface as 412 responses so UploadService can quarantine the media for inspection.
  - A READY transition automatically marks the associated media asset as cacheable for viewers.

## StreamingService → Playback Readiness Webhook

- **Endpoint**: `POST /internal/catalog/episodes/:id/assets`
- **Headers**: `x-service-auth` bearer token, same token used across internal service calls.
- **Payload**: Aligns with `registerEpisodeAssetSchema` (see `src/schemas/episode-assets.ts`). Includes variant definitions, captions, and fallback art.
- **Behaviour**: When StreamingService notifies ContentService outside Pub/Sub (e.g., manual reprocessing), the same idempotent handler is invoked. Failures return 500/412 with descriptive messages allowing StreamingService to alert operators.

## EngagementService → `engagement.metrics`

- **Topic**: `engagement.metrics`
- **Acknowledgement**: HTTP 202 from `/internal/events/engagement/metrics`.
- **Payload**:
  - `metrics[]`: Array of objects with `contentId` (UUID), `score` (non-negative float), optional `likes`, `views`, `rating` (0-5).
  - `receivedAt` (ISO8601, optional) for trace correlation.
- **Processing rules**:
  - Metrics update Redis sorted sets (`catalog:trending`, `catalog:ratings`).
  - Invalid UUIDs or missing catalog entities yield 404 responses and must be retried only after remediation.

## Playback Manifest Linkage (API Gateway)

- **Expectation**: Gateway surfaces ContentService manifest URLs verbatim. No re-signing occurs in ContentService; Gateway attaches CDN auth/query params per viewer session.
- **Validation**: Data-quality guards ensure that READY assets always include a manifest. Missing manifest entries surface as 500 responses on viewer endpoints, prompting rollback.

## Notes on Idempotency & Ordering

- All ingest routes are idempotent on `episodeId`; repeated writes simply update the latest state.
- Media asset updates carry version timestamps through the `updatedAt` column so conflicting late updates can be detected and logged.
- Engagement metrics are commutative; out-of-order events are aggregated by the TrendingService helper.
