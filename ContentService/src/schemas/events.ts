import { z } from "zod";
import { MediaAssetStatus } from "@prisma/client";

export const mediaProcessedEventSchema = z.object({
  episodeId: z.string().uuid(),
  status: z.nativeEnum(MediaAssetStatus),
  sourceUploadId: z.string().optional(),
  streamingAssetId: z.string().optional(),
  manifestUrl: z.string().url().optional(),
  defaultThumbnailUrl: z.string().url().optional(),
  variants: z
    .array(
      z.object({
        label: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        bitrateKbps: z.number().int().positive().optional(),
        codec: z.string().optional(),
        frameRate: z.number().positive().optional(),
      })
    )
    .min(1),
  occurredAt: z.string().datetime().optional(),
});

export const engagementMetricsEventSchema = z.object({
  metrics: z
    .array(
      z.object({
        contentId: z.string().uuid(),
        score: z.number().nonnegative(),
        likes: z.number().int().nonnegative().optional(),
        views: z.number().int().nonnegative().optional(),
        rating: z.number().min(0).max(5).optional(),
      })
    )
    .min(1),
  receivedAt: z.string().datetime().optional(),
});

export type MediaProcessedEvent = z.infer<typeof mediaProcessedEventSchema>;
export type EngagementMetricsEvent = z.infer<
  typeof engagementMetricsEventSchema
>;

export const mediaUploadedEventSchema = z.object({
  uploadId: z.string().uuid(),
  contentId: z.string().uuid().optional().nullable(),
  contentClassification: z.enum(["EPISODE", "REEL"]).optional().nullable(),
  fileName: z.string().optional().nullable(),
  storageUrl: z.string().optional(),
  assetType: z.string().optional(),
});

export type MediaUploadedEvent = z.infer<typeof mediaUploadedEventSchema>;
