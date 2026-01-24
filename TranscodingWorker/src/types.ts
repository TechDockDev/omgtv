/**
 * Type definitions for transcoding workflow
 */

/**
 * Message format published by UploadService (flat format)
 */
export interface MediaUploadedMessage {
    uploadId: string;
    objectKey: string;
    storageUrl: string; // gs://bucket/path
    cdnUrl: string;
    assetType: string; // "video" | "thumbnail" | "banner"
    adminId: string;
    contentId: string | null;
    contentClassification: "EPISODE" | "REEL" | null;
    sizeBytes: number;
    contentType: string; // MIME type
    validation: Record<string, unknown> | null;
    emittedAt: string;
}

export interface MediaReadyEvent {
    eventId: string;
    eventType: "media.ready";
    version: string;
    occurredAt: string;
    data: {
        uploadId: string;
        contentId: string;
        contentType: "EPISODE" | "REEL";
        manifestUrl: string; // CDN URL to master.m3u8
        thumbnailUrl?: string;
        durationSeconds: number;
        renditions: Rendition[];
        checksum: string;
    };
}

export interface MediaFailedEvent {
    eventId: string;
    eventType: "media.failed";
    version: string;
    occurredAt: string;
    data: {
        uploadId: string;
        reason: string;
        error?: unknown;
    };
}

export interface Rendition {
    name: string;
    resolution: string;
    width: number;
    height: number;
    bitrateKbps: number;
    codec: string;
    audioBitrateKbps?: number;  // Per-quality audio bitrate
}

export interface TranscodeJob {
    uploadId: string;
    contentId: string;
    contentType: "EPISODE" | "REEL";
    sourceUrl: string;
    sourceBucket: string;
    sourceObject: string;
    outputBucket: string;
    outputPrefix: string;
}

export interface TranscodeResult {
    manifestPath: string;
    manifestUrl: string;
    thumbnailPath?: string;
    durationSeconds: number;
    renditions: Rendition[];
    checksum: string;
}

// ABR Ladder Configuration (4 quality levels) - Mobile Optimized
export const ABR_PROFILES: Rendition[] = [
    {
        name: "1080p",
        resolution: "1920x1080",
        width: 1920,
        height: 1080,
        bitrateKbps: 4200,  // Optimized for mobile networks
        codec: "h264",
        audioBitrateKbps: 128,  // High audio for HD
    },
    {
        name: "720p",
        resolution: "1280x720",
        width: 1280,
        height: 720,
        bitrateKbps: 2400,  // Optimized for mobile networks
        codec: "h264",
        audioBitrateKbps: 128,  // High audio for HD
    },
    {
        name: "480p",
        resolution: "854x480",
        width: 854,
        height: 480,
        bitrateKbps: 1200,  // Optimized for mobile networks
        codec: "h264",
        audioBitrateKbps: 96,   // Medium audio for SD
    },
    {
        name: "360p",
        resolution: "640x360",
        width: 640,
        height: 360,
        bitrateKbps: 600,   // Optimized for mobile networks
        codec: "h264",
        audioBitrateKbps: 64,   // Low audio for fast start
    },
];
