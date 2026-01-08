import { createHash } from "node:crypto";
import pino, { type Logger } from "pino";
import type {
  AbrVariant,
  ChannelMetadata,
  ChannelProvisioningRequest,
  ChannelProvisioningResult,
  ChannelClassification,
} from "../types/channel";
import type { ReadyForStreamEvent } from "../types/upload";
import type { ChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import { withExponentialBackoff } from "../utils/retry";
import { OvenMediaEngineClient } from "../clients/ome-client";

interface ChannelProvisionerOptions {
  omeClient: OvenMediaEngineClient;
  repository: ChannelMetadataRepository;
  manifestBucket: string;
  reelsPreset: string;
  seriesPreset: string;
  reelsApplication: string;
  seriesApplication: string;
  reelsIngestPool: string;
  seriesIngestPool: string;
  reelsEgressPool: string;
  seriesEgressPool: string;
  maxProvisionRetries: number;
  cdnBaseUrl: string;
  signingKeyId: string;
  dryRun?: boolean;
  logger?: Logger;
}

export class ChannelProvisioner {
  private readonly omeClient: OvenMediaEngineClient;
  private readonly repository: ChannelMetadataRepository;
  private readonly manifestBucket: string;
  private readonly reelPreset: AbrVariant[];
  private readonly seriesPreset: AbrVariant[];
  private readonly reelsApplication: string;
  private readonly seriesApplication: string;
  private readonly reelsIngestPool: string;
  private readonly seriesIngestPool: string;
  private readonly reelsEgressPool: string;
  private readonly seriesEgressPool: string;
  private readonly maxProvisionRetries: number;
  private readonly cdnBaseUrl: string;
  private readonly signingKeyId: string;
  private readonly dryRun: boolean;
  private readonly logger: Logger;

  constructor(options: ChannelProvisionerOptions) {
    this.omeClient = options.omeClient;
    this.repository = options.repository;
    this.manifestBucket = options.manifestBucket;
    this.reelPreset = this.parsePreset(options.reelsPreset);
    this.seriesPreset = this.parsePreset(options.seriesPreset);
    this.reelsApplication = options.reelsApplication;
    this.seriesApplication = options.seriesApplication;
    this.reelsIngestPool = options.reelsIngestPool;
    this.seriesIngestPool = options.seriesIngestPool;
    this.reelsEgressPool = options.reelsEgressPool;
    this.seriesEgressPool = options.seriesEgressPool;
    this.maxProvisionRetries = options.maxProvisionRetries;
    this.cdnBaseUrl = options.cdnBaseUrl;
    this.signingKeyId = options.signingKeyId;
    this.dryRun = options.dryRun ?? false;
    this.logger = options.logger ?? pino({ name: "channel-provisioner" });
  }

  async provisionFromReadyEvent(
    event: ReadyForStreamEvent
  ): Promise<ChannelMetadata> {
    const classification =
      event.data.contentType === "REEL" ? "reel" : "series";
    const omeApplication =
      event.data.omeHints?.application ??
      (event.data.contentType === "REEL"
        ? this.reelsApplication
        : this.seriesApplication);
    const protocol =
      event.data.omeHints?.protocol ??
      (event.data.contentType === "REEL" ? "ll-hls" : "hls");
    const existing = await this.repository.findByContentId(event.data.videoId);
    const incomingChecksum = event.data.processedAsset.checksum;

    if (
      existing &&
      existing.checksum === incomingChecksum &&
      existing.status === "ready"
    ) {
      this.logger.info(
        { contentId: event.data.videoId },
        "Channel already provisioned with matching checksum"
      );
      return existing;
    }

    const manifestPath = event.data.processedAsset.manifestObject;
    const cacheKey = this.buildCacheKey(event.data.videoId, incomingChecksum);
    const abrLadder = this.selectPreset(classification);
    const sourceUri = this.buildSourceUri(event);
    const outputBucket =
      event.data.processedAsset.bucket || this.manifestBucket;

    const request: ChannelProvisioningRequest = {
      contentId: event.data.videoId,
      classification,
      omeApplication,
      protocol,
      sourceUri,
      ingestPool: this.selectIngestPool(classification),
      egressPool: this.selectEgressPool(classification),
      abrLadder,
      outputBucket,
      manifestPath,
      cacheKey,
      drm: event.data.encryption,
      metadata: {
        tenantId: event.data.tenantId,
        checksum: incomingChecksum,
        ingestRegion: event.data.ingestRegion,
        readyAt: event.data.readyAt,
        idempotencyKey: event.data.idempotencyKey,
        signingKeyId: this.signingKeyId,
        dryRun: this.dryRun ? "true" : "false",
      },
    };

    const baseRecord: ChannelMetadata = {
      contentId: event.data.videoId,
      channelId: existing?.channelId ?? "pending",
      classification,
      omeApplication,
      protocol,
      manifestPath,
      playbackUrl: this.buildPlaybackUrl(
        manifestPath,
        event.data.cdn?.defaultBaseUrl
      ),
      originEndpoint: existing?.originEndpoint ?? "pending",
      cacheKey,
      checksum: incomingChecksum,
      status: "provisioning",
      retries: existing ? existing.retries + 1 : 0,
      sourceAssetUri: event.data.sourceUpload.storageUrl ?? sourceUri,
      tenantId: event.data.tenantId,
      readyAt: event.data.readyAt,
      gcsBucket: outputBucket,
      storagePrefix:
        event.data.processedAsset.storagePrefix ??
        (this.deriveStoragePrefix(event.data.processedAsset.manifestObject) ||
          undefined),
      renditions: event.data.processedAsset.renditions,
      lastProvisionedAt: new Date().toISOString(),
      drm: event.data.encryption,
      ingestRegion: event.data.ingestRegion,
    };

    await this.repository.upsert(baseRecord);

    let response: ChannelProvisioningResult | undefined;
    try {
      response = await withExponentialBackoff(
        () => this.omeClient.createChannel(request),
        {
          retries: this.maxProvisionRetries,
          onRetry: (err, attempt) =>
            this.logger.warn(
              { err, attempt, contentId: event.data.videoId },
              "Provisioning retry"
            ),
        }
      );
    } catch (error) {
      await this.repository.upsert({
        ...baseRecord,
        status: "failed",
        retries: baseRecord.retries + 1,
        lastProvisionedAt: new Date().toISOString(),
      });
      throw error;
    }

    const finalRecord: ChannelMetadata = {
      ...baseRecord,
      channelId: response.channelId,
      manifestPath: response.manifestPath ?? baseRecord.manifestPath,
      playbackUrl:
        response.playbackBaseUrl ??
        this.buildPlaybackUrl(
          response.manifestPath ?? baseRecord.manifestPath,
          event.data.cdn?.defaultBaseUrl
        ),
      originEndpoint: response.originEndpoint,
      status: "ready",
      lastProvisionedAt: new Date().toISOString(),
    };
    await this.repository.upsert(finalRecord);
    this.logger.info(
      { contentId: finalRecord.contentId, channelId: finalRecord.channelId },
      "Channel provisioned"
    );
    return finalRecord;
  }

  private parsePreset(preset: string): AbrVariant[] {
    return preset
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, resolution, bitrate] = entry
          .split("|")
          .map((value) => value.trim());
        if (!name || !resolution || !bitrate) {
          throw new Error(`Invalid ABR preset entry: ${entry}`);
        }
        const bitrateKbps = Number.parseInt(bitrate, 10);
        if (Number.isNaN(bitrateKbps)) {
          throw new Error(`Invalid bitrate in ABR preset entry: ${entry}`);
        }
        return {
          name,
          resolution,
          bitrateKbps,
        } satisfies AbrVariant;
      });
  }

  private selectPreset(classification: ChannelClassification) {
    return classification === "reel" ? this.reelPreset : this.seriesPreset;
  }

  private selectIngestPool(classification: ChannelClassification) {
    return classification === "reel"
      ? this.reelsIngestPool
      : this.seriesIngestPool;
  }

  private selectEgressPool(classification: ChannelClassification) {
    return classification === "reel"
      ? this.reelsEgressPool
      : this.seriesEgressPool;
  }

  private buildPlaybackUrl(manifestPath: string, baseUrl?: string) {
    const origin = baseUrl ?? this.cdnBaseUrl;
    return new URL(manifestPath, origin).toString();
  }

  private buildCacheKey(contentId: string, checksum: string) {
    return createHash("sha1").update(`${contentId}:${checksum}`).digest("hex");
  }

  private buildSourceUri(event: ReadyForStreamEvent) {
    const bucket = event.data.processedAsset.bucket;
    if (event.data.processedAsset.storagePrefix) {
      return this.buildGcsUri(bucket, event.data.processedAsset.storagePrefix);
    }
    const derived = this.deriveStoragePrefix(
      event.data.processedAsset.manifestObject
    );
    if (derived) {
      return this.buildGcsUri(bucket, derived);
    }
    if (event.data.sourceUpload.storageUrl) {
      return event.data.sourceUpload.storageUrl;
    }
    return this.buildGcsUri(bucket, event.data.processedAsset.manifestObject);
  }

  private deriveStoragePrefix(manifestObject: string) {
    const lastSlash = manifestObject.lastIndexOf("/");
    if (lastSlash === -1) {
      return "";
    }
    return manifestObject.slice(0, lastSlash);
  }

  private buildGcsUri(bucket: string, objectPath: string) {
    const normalized = objectPath.replace(/^\/+/, "");
    return `gs://${bucket}/${normalized}`;
  }
}
