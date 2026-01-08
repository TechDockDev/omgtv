import { performance } from "node:perf_hooks";
import { withExponentialBackoff } from "../utils/retry";
import type { ChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import type { CdnTokenSigner } from "../utils/cdn-signature";
import type { AuthServiceClient, ViewerContext } from "../clients/auth-client";
import type { AlertingService } from "./alerting-service";
import type { MetricsRegistry } from "./metrics-registry";
import type { Env } from "../config";
import { randomUUID } from "node:crypto";
import type { ChannelMetadata } from "../types/channel";

export class ManifestAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "ManifestAccessError";
  }
}

export interface ManifestRequest {
  contentId: string;
  quality?: string;
  device?: string;
  viewerToken: string;
  viewerGeo?: string;
  sessionId?: string;
  correlationId?: string;
}

export interface ManifestResponsePayload {
  manifestUrl: string;
  expiresAt: string;
  cdn: string;
  drm?: ChannelMetadata["drm"];
  entitlements: string[];
  policy: {
    cacheControl: string;
    ttlSeconds: number;
    failover: boolean;
  };
  availability?: ChannelMetadata["availabilityWindow"];
}

export class ManifestService {
  constructor(
    private readonly repository: ChannelMetadataRepository,
    private readonly cdnSigner: CdnTokenSigner,
    private readonly authClient: AuthServiceClient,
    private readonly alerting: AlertingService,
    private readonly metrics: MetricsRegistry,
    private readonly config: Env
  ) {}

  async getManifest(
    request: ManifestRequest
  ): Promise<ManifestResponsePayload> {
    const start = performance.now();
    try {
      const viewer = await this.authClient.introspect(
        request.viewerToken,
        request.correlationId
      );
      this.ensureScopes(viewer, request.contentId);

      const channel = await withExponentialBackoff(
        () => this.fetchChannel(request.contentId),
        {
          retries: 2,
        }
      );

      this.ensurePolicies(channel, viewer, request.viewerGeo);

      const preferFailover = this.shouldFailover(channel, viewer);
      const signed = this.cdnSigner.signManifest({
        channel,
        ttlSeconds: this.config.SIGNED_URL_TTL_SECONDS,
        sessionId: request.sessionId ?? viewer.sessionId ?? randomUUID(),
        device: request.device,
        quality: request.quality,
        preferFailover,
      });

      const response: ManifestResponsePayload = {
        manifestUrl: signed.url,
        expiresAt: signed.expiresAt,
        cdn: signed.cdnHost,
        drm: channel.drm,
        entitlements: viewer.entitlements,
        policy: {
          cacheControl: "private, max-age=30, stale-while-revalidate=30",
          ttlSeconds: this.config.SIGNED_URL_TTL_SECONDS,
          failover: signed.failover,
        },
        availability: channel.availabilityWindow,
      };

      this.metrics.recordManifest("success");
      this.metrics.recordManifestLatency(
        request.contentId,
        Math.round(performance.now() - start)
      );
      return response;
    } catch (error) {
      this.metrics.recordManifest("error");
      await this.alerting.manifestLatency(
        request.contentId,
        Math.round(performance.now() - start)
      );
      if (error instanceof ManifestAccessError) {
        throw error;
      }
      throw new ManifestAccessError(
        error instanceof Error ? error.message : "Manifest failed",
        500
      );
    }
  }

  private async fetchChannel(contentId: string) {
    const channel = await this.repository.findByContentId(contentId);
    if (!channel) {
      throw new ManifestAccessError("Stream not found", 404);
    }
    if (channel.status !== "ready") {
      throw new ManifestAccessError(`Stream is ${channel.status}`, 409);
    }
    return channel;
  }

  private ensureScopes(viewer: ViewerContext, contentId: string) {
    if (!viewer.scopes?.includes("streams.read")) {
      throw new ManifestAccessError("Viewer lacks streams.read scope", 403);
    }
    if (
      viewer.entitlements.length > 0 &&
      !viewer.entitlements.includes(contentId)
    ) {
      throw new ManifestAccessError("Viewer not entitled to content", 403);
    }
  }

  private ensurePolicies(
    channel: ChannelMetadata,
    viewer: ViewerContext,
    geoOverride?: string
  ) {
    if (channel.availabilityWindow) {
      const now = new Date();
      if (now < new Date(channel.availabilityWindow.startsAt)) {
        throw new ManifestAccessError("Content not yet available", 409);
      }
      if (now > new Date(channel.availabilityWindow.endsAt)) {
        throw new ManifestAccessError(
          "Content availability window expired",
          410
        );
      }
    }

    const viewerGeo = geoOverride ?? viewer.geo;
    if (channel.geoRestrictions) {
      if (
        channel.geoRestrictions.deny?.length &&
        viewerGeo &&
        channel.geoRestrictions.deny.includes(viewerGeo)
      ) {
        throw new ManifestAccessError("Geo restricted", 451);
      }
      if (
        channel.geoRestrictions.allow?.length &&
        viewerGeo &&
        !channel.geoRestrictions.allow.includes(viewerGeo)
      ) {
        throw new ManifestAccessError("Geo restricted", 451);
      }
    }
  }

  private shouldFailover(channel: ChannelMetadata, viewer: ViewerContext) {
    if (
      !channel.ingestRegion ||
      !viewer.geo ||
      !this.config.CDN_FAILOVER_BASE_URL
    ) {
      return false;
    }
    return channel.ingestRegion !== viewer.geo;
  }
}
