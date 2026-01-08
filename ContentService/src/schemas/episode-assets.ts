import { z } from "zod";
import { MediaAssetStatus, PublicationStatus } from "@prisma/client";

export const registerEpisodeAssetSchema = z.object({
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
});

export const moderationQueueQuerySchema = z.object({
  status: z.nativeEnum(PublicationStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
});
