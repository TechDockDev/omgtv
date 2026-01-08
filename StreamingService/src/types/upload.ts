export type ReadyForStreamContentType = "REEL" | "EPISODE";

export interface ReadyForStreamEvent {
  eventId: string;
  eventType: "media.ready-for-stream";
  version: string;
  occurredAt: string;
  data: ReadyForStreamEventData;
  acknowledgement?: {
    deadlineSeconds: number;
    required: boolean;
  };
}

export interface ReadyForStreamEventData {
  uploadId: string;
  videoId: string;
  tenantId: string;
  contentType: ReadyForStreamContentType;
  sourceUpload: {
    storageUrl?: string | null;
    objectKey: string;
    sizeBytes: number;
    contentType: string;
  };
  processedAsset: {
    bucket: string;
    manifestObject: string;
    storagePrefix?: string;
    renditions: Array<{
      name: string;
      codec: string;
      bitrateKbps: number;
      resolution: string;
      frameRate?: number;
    }>;
    checksum: string;
    signedUrlTtlSeconds: number;
    lifecycle?: {
      storageClass: string;
      retentionDays?: number;
    };
  };
  encryption?: {
    keyId: string;
    licenseServer: string;
  };
  ingestRegion: string;
  cdn: {
    defaultBaseUrl: string;
  };
  omeHints?: {
    application: string;
    protocol: string;
  };
  idempotencyKey: string;
  readyAt: string;
}
