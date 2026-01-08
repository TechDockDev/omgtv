import type { ContentResponse } from "../schemas/content";

export function buildStubContentResponse(params: {
  id: string;
  cdnBaseUrl: string;
  defaultOwnerId: string;
  now?: Date;
}): ContentResponse {
  const nowIso = (params.now ?? new Date()).toISOString();
  const thumbnailBase = `${params.cdnBaseUrl.replace(/\/$/, "")}/thumbnails/${params.id}`;

  return {
    id: params.id,
    title: `PocketLOL Video ${params.id.substring(0, 8)}`,
    description: "Stub video metadata returned by ContentService",
    durationSeconds: 900,
    ownerId: params.defaultOwnerId,
    publishedAt: nowIso,
    visibility: "public",
    tags: ["stub", "demo"],
    thumbnails: [
      {
        url: `${thumbnailBase}/default.jpg`,
        width: 1280,
        height: 720,
      },
      {
        url: `${thumbnailBase}/hq.jpg`,
        width: 1920,
        height: 1080,
      },
    ],
    stats: {
      views: 4_250,
      likes: 250,
      comments: 32,
    },
  };
}
