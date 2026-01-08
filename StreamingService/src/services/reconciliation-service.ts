import { randomUUID } from "node:crypto";
import type { ChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import type { ChannelProvisioner } from "./channel-provisioner";
import type { AlertingService } from "./alerting-service";
import type { Logger } from "pino";
import type {
  ReadyForStreamEvent,
  ReadyForStreamContentType,
} from "../types/upload";
import type { ChannelMetadata } from "../types/channel";

interface ReconciliationDefaults {
  manifestBucket?: string;
  cdnBaseUrl?: string;
}

export class ReconciliationService {
  private readonly logger: Logger;
  private readonly manifestBucket: string;
  private readonly cdnBaseUrl: string;

  constructor(
    private readonly repository: ChannelMetadataRepository,
    private readonly provisioner: ChannelProvisioner,
    private readonly alerting: AlertingService,
    logger: Logger,
    defaults: ReconciliationDefaults = {}
  ) {
    this.logger = logger;
    this.manifestBucket =
      defaults.manifestBucket ??
      process.env.GCS_MANIFEST_BUCKET ??
      "pocketlol-streaming-manifests";
    this.cdnBaseUrl =
      defaults.cdnBaseUrl ??
      process.env.CDN_BASE_URL ??
      "https://stream.cdn.pocketlol";
  }

  async reconcileFailed(limit = 20) {
    const failed = await this.repository.listFailed(limit);
    for (const record of failed) {
      try {
        this.logger.info(
          { contentId: record.contentId },
          "Replaying failed provisioning"
        );
        const replayEvent = this.buildReplayEvent(record);
        await this.provisioner.provisionFromReadyEvent(replayEvent);
      } catch (error) {
        this.alerting.ingestFailure(record.contentId, error);
      }
    }
  }

  private buildReplayEvent(record: ChannelMetadata): ReadyForStreamEvent {
    const manifestObject = record.manifestPath;
    const bucket = record.gcsBucket ?? this.manifestBucket;
    const storagePrefix =
      record.storagePrefix ?? this.deriveStoragePrefix(manifestObject);
    return {
      eventId: `reconcile-${record.contentId}-${randomUUID()}`,
      eventType: "media.ready-for-stream",
      version: "2025-01-01",
      occurredAt: new Date().toISOString(),
      data: {
        uploadId: record.contentId,
        videoId: record.contentId,
        tenantId: record.tenantId ?? "pocketlol",
        contentType: this.mapClassification(record.classification),
        sourceUpload: {
          storageUrl: record.sourceAssetUri,
          objectKey: this.extractObjectKey(record.sourceAssetUri),
          sizeBytes: 0,
          contentType: "application/vnd.apple.mpegurl",
        },
        processedAsset: {
          bucket,
          manifestObject,
          storagePrefix,
          renditions: record.renditions ?? [],
          checksum: record.checksum,
          signedUrlTtlSeconds: 300,
        },
        encryption: record.drm,
        ingestRegion: record.ingestRegion ?? "us-central1",
        cdn: { defaultBaseUrl: this.cdnBaseUrl },
        omeHints: {
          application: record.omeApplication,
          protocol: record.protocol,
        },
        idempotencyKey: record.cacheKey,
        readyAt: record.readyAt ?? record.lastProvisionedAt,
      },
    };
  }

  private mapClassification(
    classification: ChannelMetadata["classification"]
  ): ReadyForStreamContentType {
    return classification === "reel" ? "REEL" : "EPISODE";
  }

  private deriveStoragePrefix(manifestPath: string) {
    const idx = manifestPath.lastIndexOf("/");
    return idx === -1 ? "" : manifestPath.slice(0, idx);
  }

  private extractObjectKey(sourceUri: string) {
    if (!sourceUri) {
      return "";
    }
    if (sourceUri.startsWith("gs://")) {
      const withoutScheme = sourceUri.slice(5);
      const slash = withoutScheme.indexOf("/");
      return slash === -1 ? "" : withoutScheme.slice(slash + 1);
    }
    try {
      const url = new URL(sourceUri);
      return url.pathname.replace(/^\/+/, "");
    } catch {
      return sourceUri;
    }
  }
}
