import type { Logger } from "pino";

export interface ContentMetadata {
  id: string;
  slug: string;
  tags: string[];
  availability: {
    start: string | null;
    end: string | null;
  };
  playback: {
    status: string;
    manifestUrl: string | null;
    variants: Array<{
      label: string;
      width: number | null;
      height: number | null;
      bitrateKbps: number | null;
      codec: string | null;
    }>;
  };
}

interface ContentServiceClientOptions {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  logger: Logger;
}

export class ContentServiceClient {
  private readonly baseUrl: string;
  private readonly serviceToken?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: ContentServiceClientOptions) {
    this.baseUrl = options.baseUrl;
    this.serviceToken = options.serviceToken;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.logger = options.logger.child({ module: "content-client" });
  }

  async getEpisodeMetadata(
    contentId: string,
    correlationId?: string
  ): Promise<ContentMetadata | null> {
    const url = new URL(`/internal/catalog/media/${contentId}`, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.serviceToken) {
        headers.authorization = `Bearer ${this.serviceToken}`;
      }
      if (correlationId) {
        headers["x-correlation-id"] = correlationId;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const body = await response.text();
        this.logger.warn(
          {
            status: response.status,
            body,
            contentId,
          },
          "ContentService metadata fetch failed"
        );
        throw new Error(
          `ContentService request failed (${response.status}): ${body}`
        );
      }

      const payload = (await response.json()) as ContentMetadata;
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureEpisodeExists(
    contentId: string,
    correlationId?: string
  ): Promise<ContentMetadata> {
    const metadata = await this.getEpisodeMetadata(contentId, correlationId);
    if (!metadata) {
      throw new Error(`Content ${contentId} not found in catalog`);
    }
    if (metadata.playback.status !== "READY") {
      throw new Error(
        `Content ${contentId} is not ready for playback (${metadata.playback.status})`
      );
    }
    return metadata;
  }
}
