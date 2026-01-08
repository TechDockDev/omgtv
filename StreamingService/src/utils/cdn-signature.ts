import { createHmac, randomUUID } from "node:crypto";
import type { ChannelMetadata } from "../types/channel";

interface CdnTokenSignerOptions {
  signingKeyId: string;
  signingSecret: string;
  primaryBaseUrl: string;
  failoverBaseUrl?: string;
}

interface SignManifestOptions {
  channel: ChannelMetadata;
  ttlSeconds: number;
  sessionId?: string;
  device?: string;
  quality?: string;
  preferFailover?: boolean;
}

interface SignedManifest {
  url: string;
  expiresAt: string;
  cdnHost: string;
  failover: boolean;
}

export class CdnTokenSigner {
  private readonly signingKeyId: string;
  private readonly signingSecret: string;
  private readonly primaryBaseUrl: string;
  private readonly failoverBaseUrl?: string;

  constructor(options: CdnTokenSignerOptions) {
    this.signingKeyId = options.signingKeyId;
    this.signingSecret = options.signingSecret;
    this.primaryBaseUrl = options.primaryBaseUrl;
    this.failoverBaseUrl = options.failoverBaseUrl;
  }

  signManifest(options: SignManifestOptions): SignedManifest {
    const expiresAt = new Date(Date.now() + options.ttlSeconds * 1000);
    const session = options.sessionId ?? randomUUID();
    const baseUrl = this.resolveBaseUrl(options);
    const url = new URL(options.channel.manifestPath, baseUrl);

    if (options.quality) {
      url.searchParams.set("quality", options.quality);
    }
    if (options.device) {
      url.searchParams.set("device", options.device);
    }

    url.searchParams.set("expires", expiresAt.toISOString());
    url.searchParams.set("session", session);
    url.searchParams.set("keyId", this.signingKeyId);

    const canonical = this.buildCanonical(url);
    const signature = createHmac("sha256", this.signingSecret)
      .update(canonical)
      .digest("hex");

    url.searchParams.set("token", randomUUID().replace(/-/g, ""));
    url.searchParams.set("sig", signature);

    return {
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
      cdnHost: url.host,
      failover: baseUrl !== this.primaryBaseUrl,
    };
  }

  private resolveBaseUrl(options: SignManifestOptions) {
    if (options.preferFailover && this.failoverBaseUrl) {
      return this.failoverBaseUrl;
    }
    return this.primaryBaseUrl;
  }

  private buildCanonical(url: URL) {
    const clone = new URL(url.toString());
    clone.searchParams.delete("sig");
    const params = Array.from(clone.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const serialized = params
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    return `${clone.pathname}?${serialized}`;
  }
}
