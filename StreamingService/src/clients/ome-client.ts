import { createHmac, randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import type {
  ChannelProvisioningRequest,
  ChannelProvisioningResult,
} from "../types/channel";

interface OmeClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs?: number;
  dryRun?: boolean;
  logger?: Logger;
}

interface OmeChannelResponse {
  id: string;
  manifestPath: string;
  originEndpoint: string;
  playbackBaseUrl: string;
  profileHash: string;
}

export interface OmeRealtimeChannel {
  channelId: string;
  viewers: number;
  avgBitrateKbps: number;
  bufferEventsPerMin: number;
  ingestRegion?: string;
  egressRegion?: string;
}

export interface OmeRealtimeStats {
  sampledAt: string;
  channels: OmeRealtimeChannel[];
}

export class OvenMediaEngineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly timeoutMs: number;
  private readonly dryRun: boolean;
  private readonly logger: Logger;

  constructor(options: OmeClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.dryRun = options.dryRun ?? false;
    this.logger = options.logger ?? pino({ name: "ome-client" });
  }

  async createChannel(
    request: ChannelProvisioningRequest
  ): Promise<ChannelProvisioningResult> {
    if (this.dryRun) {
      this.logger.debug({ request }, "Dry-run channel provisioning");
      return this.buildDryRunResult(request);
    }

    const payload = {
      channel: {
        name: request.contentId,
        classification: request.classification,
        ingestPool: request.ingestPool,
        egressPool: request.egressPool,
        application: request.omeApplication,
        protocol: request.protocol,
        source: {
          uri: request.sourceUri,
        },
        abr: request.abrLadder.map((variant) => ({
          name: variant.name,
          resolution: variant.resolution,
          bitrateKbps: variant.bitrateKbps,
        })),
        output: {
          bucket: request.outputBucket,
          manifestPath: request.manifestPath,
        },
        cacheKey: request.cacheKey,
        metadata: request.metadata,
        drm: request.drm ?? null,
      },
    };

    const response = await this.request<OmeChannelResponse>(
      "POST",
      "/v1/channels",
      payload
    );

    return {
      channelId: response.id,
      manifestPath: response.manifestPath,
      originEndpoint: response.originEndpoint,
      playbackBaseUrl: response.playbackBaseUrl,
      profileHash: response.profileHash,
    };
  }

  async deleteChannel(channelId: string): Promise<void> {
    if (this.dryRun) {
      this.logger.debug({ channelId }, "Dry-run channel deletion");
      return;
    }
    await this.request("DELETE", `/v1/channels/${channelId}`);
  }

  async rotateIngestKey(channelId: string): Promise<void> {
    if (this.dryRun) {
      this.logger.debug({ channelId }, "Dry-run ingest key rotation");
      return;
    }
    await this.request("POST", `/v1/channels/${channelId}/rotate-ingest`);
  }

  async describeChannel(channelId: string): Promise<OmeChannelResponse> {
    return this.request("GET", `/v1/channels/${channelId}`);
  }

  async getRealtimeStats(): Promise<OmeRealtimeStats> {
    if (this.dryRun) {
      return {
        sampledAt: new Date().toISOString(),
        channels: [],
      };
    }
    return this.request("GET", "/v1/metrics/realtime");
  }

  private buildDryRunResult(
    request: ChannelProvisioningRequest
  ): ChannelProvisioningResult {
    const manifestPath = request.manifestPath;
    return {
      channelId: `dry-${randomUUID()}`,
      manifestPath,
      originEndpoint: `${this.baseUrl}/origin/${request.contentId}`,
      playbackBaseUrl: `${this.baseUrl}/vod/${request.contentId}`,
      profileHash: createHmac("sha256", this.apiSecret)
        .update(JSON.stringify(request.abrLadder))
        .digest("hex"),
    };
  }

  private buildHeaders(method: string, path: string, body?: string) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const canonical = `${method}\n${path}\n${timestamp}\n${body ?? ""}`;
    const signature = createHmac("sha256", this.apiSecret)
      .update(canonical)
      .digest("hex");

    return {
      "x-ome-key": this.apiKey,
      "x-ome-nonce": nonce,
      "x-ome-timestamp": timestamp,
      "x-ome-signature": signature,
    };
  }

  private async request<T = void>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL(path, this.baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {
      "content-type": "application/json",
      ...this.buildHeaders(method, url.pathname, payload),
    };

    try {
      const response = await fetch(url, {
        method,
        body: payload,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text();
        const error = new Error(
          `OME request failed (${response.status}): ${errorBody}`
        );
        this.logger.error({ method, path, errorBody }, "OME request failure");
        throw error;
      }
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error({ method, path, err: error }, "OME request error");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
