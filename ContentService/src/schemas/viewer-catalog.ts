import { MediaAssetStatus } from "@prisma/client";
import { z } from "zod";

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  viewerId: z.string().uuid().optional(),
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
  status: z.nativeEnum(MediaAssetStatus),
  manifestUrl: z.string().url().nullable(),
  defaultThumbnailUrl: z.string().url().nullable(),
  variants: z.array(playbackVariantSchema),
});

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

const seasonSchema = z
  .object({
    id: z.string().uuid(),
    sequenceNumber: z.number().int().nonnegative(),
    title: z.string().nullable(),
  })
  .nullable();

const categorySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
  })
  .nullable();

const feedItemSchema = z.object({
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
  season: seasonSchema,
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

export const viewerFeedItemSchema = feedItemSchema;

export const feedResponseSchema = z.object({
  items: z.array(feedItemSchema),
  nextCursor: z.string().nullable(),
});

export const seriesDetailParamsSchema = z.object({
  slug: z.string(),
});

export const seriesDetailByIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const seriesDetailResponseSchema = z.object({
  series: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    synopsis: z.string().nullable(),
    heroImageUrl: z.string().url().nullable(),
    bannerImageUrl: z.string().url().nullable(),
    tags: z.array(z.string()),
    releaseDate: z.string().datetime().nullable(),
    category: categorySchema,
  }),
  seasons: z.array(
    z.object({
      id: z.string().uuid(),
      sequenceNumber: z.number().int().nonnegative(),
      title: z.string(),
      synopsis: z.string().nullable(),
      releaseDate: z.string().datetime().nullable(),
      episodes: z.array(feedItemSchema),
    })
  ),
  standaloneEpisodes: z.array(feedItemSchema),
});

export const relatedSeriesParamsSchema = z.object({
  slug: z.string(),
});

export const relatedSeriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const relatedSeriesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      title: z.string(),
      synopsis: z.string().nullable(),
      heroImageUrl: z.string().url().nullable(),
      bannerImageUrl: z.string().url().nullable(),
      category: categorySchema,
    })
  ),
});

export const batchContentRequestSchema = z.object({
  ids: z.array(z.string().uuid()),
  type: z.enum(["reel", "series", "episode"]),
});

export const batchContentResponseSchema = z.object({
  items: z.array(z.any()),
});

export const categoryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
});

export const categoryListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      displayOrder: z.number().int().nullable(),
    })
  ),
  nextCursor: z.string().uuid().nullable(),
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedResponse = z.infer<typeof feedResponseSchema>;
export type SeriesDetailResponse = z.infer<typeof seriesDetailResponseSchema>;
export type RelatedSeriesResponse = z.infer<typeof relatedSeriesResponseSchema>;
export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;
export type FeedItem = z.infer<typeof feedItemSchema>;
