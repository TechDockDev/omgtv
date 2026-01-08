import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

export const contentParamsSchema = z.object({
  id: z.string().uuid(),
});

const playbackVariantSchema = z.object({
  label: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  bitrateKbps: z.number().int().positive().nullable(),
  codec: z.string().nullable(),
  frameRate: z.number().positive().nullable(),
});

const playbackSchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]),
  manifestUrl: z.string().url().nullable(),
  defaultThumbnailUrl: z.string().url().nullable(),
  variants: z.array(playbackVariantSchema),
});

const categorySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
  })
  .nullable();

const localizationSchema = z.object({
  captions: z.array(
    z.object({
      language: z.string(),
      label: z.string().optional(),
      url: z.string().url().optional(),
    })
  ),
  availableLanguages: z.array(z.string()),
});

export const contentResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  synopsis: z.string().nullable(),
  heroImageUrl: z.string().url().nullable(),
  defaultThumbnailUrl: z.string().url().nullable(),
  durationSeconds: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  availability: z.object({
    start: z.string().datetime().nullable(),
    end: z.string().datetime().nullable(),
  }),
  season: z
    .object({
      id: z.string().uuid(),
      sequenceNumber: z.number().int().nonnegative(),
      title: z.string().nullable(),
    })
    .nullable(),
  series: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    synopsis: z.string().nullable(),
    heroImageUrl: z.string().url().nullable(),
    bannerImageUrl: z.string().url().nullable(),
    category: categorySchema,
  }),
  playback: playbackSchema,
  localization: localizationSchema,
  personalization: z.object({
    reason: z.enum(["trending", "recent", "viewer_following"]),
    score: z.number().optional(),
  }),
  ratings: z.object({
    average: z.number().nonnegative().nullable(),
  }),
});

export const contentSuccessResponseSchema = createSuccessResponseSchema(
  contentResponseSchema
);

export type ContentParams = z.infer<typeof contentParamsSchema>;
export type ContentResponse = z.infer<typeof contentResponseSchema>;
export type ContentSuccessResponse = SuccessResponse<ContentResponse>;

const adminCarouselSelectionSchema = z
  .object({
    seriesId: z.string().uuid().optional(),
    episodeId: z.string().uuid().optional(),
  })
  .refine((value) => {
    const hasSeries = Boolean(value.seriesId);
    const hasEpisode = Boolean(value.episodeId);
    return hasSeries !== hasEpisode;
  }, "Provide either seriesId or episodeId");

export const adminCarouselBodySchema = z.object({
  items: z
    .array(adminCarouselSelectionSchema)
    .min(1, "At least one carousel entry is required")
    .max(50, "Carousel limit is 50 entries"),
});

const adminCarouselSeriesSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    synopsis: z.string().nullable(),
    heroImageUrl: z.string().url().nullable(),
    bannerImageUrl: z.string().url().nullable(),
    category: z.string().nullable(),
  })
  .nullable();

const adminCarouselEpisodeSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    seriesId: z.string().uuid(),
    seriesTitle: z.string(),
    durationSeconds: z.number().int().positive(),
    manifestUrl: z.string().url().nullable(),
    thumbnailUrl: z.string().url().nullable(),
    publishedAt: z.string().datetime().nullable(),
  })
  .nullable();

const adminCarouselEntrySchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  type: z.enum(["episode", "series"]),
  series: adminCarouselSeriesSchema,
  episode: adminCarouselEpisodeSchema,
});

export const adminCarouselResponseSchema = z.object({
  items: z.array(adminCarouselEntrySchema),
});

export const adminCarouselSuccessResponseSchema = createSuccessResponseSchema(
  adminCarouselResponseSchema
);

export type AdminCarouselBody = z.infer<typeof adminCarouselBodySchema>;
export type AdminCarouselResponse = z.infer<typeof adminCarouselResponseSchema>;
