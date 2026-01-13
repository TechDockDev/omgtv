import { z } from "zod";

const responseEnvelope = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    success: z.literal(true),
    statusCode: z.literal(200),
    userMessage: z.string(),
    developerMessage: z.string(),
    data: schema,
  });

const streamingVariantSchema = z.object({
  quality: z.string(),
  bitrate: z.string().nullable(),
  resolution: z.string().nullable(),
  size_mb: z.number().nullable(),
  url: z.string().url().nullable(),
});

export const streamingInfoSchema = z.object({
  can_watch: z.boolean(),
  plan_purchased: z.boolean(),
  type: z.string(),
  master_playlist: z.string().url().nullable(),
  qualities: z.array(streamingVariantSchema),
});

const progressSchema = z.object({
  watched_duration: z.number().int().nonnegative(),
  total_duration: z.number().int().positive(),
  percentage: z.number().min(0),
  last_watched_at: z.string().datetime().nullable(),
  is_completed: z.boolean(),
});

const engagementSchema = z.object({
  likeCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
  isSaved: z.boolean(),
});

const continueWatchItemSchema = z.object({
  series_id: z.string(),
  episode_id: z.string(),
  episode: z.number().int().nullable(),
  series_title: z.string(),
  title: z.string(),
  thumbnail: z.string().url().nullable(),
  duration_seconds: z.number().int().positive(),
  streaming: streamingInfoSchema,
  progress: progressSchema,
  rating: z.number().nullable(),
  engagement: engagementSchema.nullable().optional(),
});

const carouselItemSchema = z.object({
  id: z.string(),
  priority: z.number().int().positive(),
  type: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  videoUrl: z.string().url().nullable(),
  rating: z.number().nullable(),
  series_id: z.string().nullable(),
  engagement: engagementSchema.nullable().optional(),
});

const sectionItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  duration: z.string().nullable(),
  watchedDuration: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  rating: z.number().nullable(),
  lastWatchedAt: z.string().datetime().nullable(),
  series_id: z.string().nullable(),
  engagement: engagementSchema.nullable().optional(),
});

const sectionSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  priority: z.number().int().positive(),
  items: z.array(sectionItemSchema),
});

const paginationSchema = z.object({
  currentPage: z.number().int().min(1),
  totalPages: z.number().int().min(1),
  hasNextPage: z.boolean(),
  nextCursor: z.string().nullable().optional(),
});

export const mobileHomeDataSchema = z.object({
  carousel: z.array(carouselItemSchema),
  "continue watch": z.array(continueWatchItemSchema),
  sections: z.array(sectionSchema),
  pagination: paginationSchema,
});

export const mobileTagsResponseSchema = z.object({
  tags: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      order: z.number().int().positive(),
      slug: z.string(),
    })
  ),
  pagination: z.object({
    nextCursor: z.string().uuid().nullable(),
  }),
});

const trailerSchema = z
  .object({
    thumbnail: z.string().url().nullable(),
    duration_seconds: z.number().int().positive(),
    streaming: streamingInfoSchema,
  })
  .nullable();

const seriesEpisodeSchema = z.object({
  series_id: z.string(),
  episode_id: z.string(),
  episode: z.number().int().nullable(),
  season: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  thumbnail: z.string().url().nullable(),
  duration_seconds: z.number().int().positive(),
  release_date: z.string().datetime().nullable(),
  is_download_allowed: z.boolean(),
  rating: z.number().nullable(),
  views: z.number().nullable(),
  streaming: streamingInfoSchema,
  progress: progressSchema,
  engagement: engagementSchema.nullable().optional(),
});

export const mobileSeriesDataSchema = z.object({
  series_id: z.string(),
  series_title: z.string(),
  synopsis: z.string().nullable(),
  thumbnail: z.string().url().nullable(),
  banner: z.string().url().nullable(),
  tags: z.array(z.string()),
  category: z.string().nullable(),
  trailer: trailerSchema,
  episodes: z.array(seriesEpisodeSchema),
  engagement: engagementSchema.nullable().optional(),
  reviews: z.object({
    summary: z.object({
      average_rating: z.number().nullable(),
      total_reviews: z.number().int().nonnegative(),
    }),
    user_reviews: z.array(
      z.object({
        review_id: z.string(),
        user_id: z.string().nullable(),
        user_name: z.string().nullable(),
        rating: z.number().nullable(),
        title: z.string().nullable(),
        comment: z.string().nullable(),
        created_at: z.string().datetime(),
      })
    ),
  }),
});

const reelItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  duration_seconds: z.number().int().positive(),
  rating: z.number().nullable(),
  thumbnail: z.string().url().nullable(),
  streaming: streamingInfoSchema,
  engagement: engagementSchema.nullable().optional(),
});

export const mobileReelsDataSchema = z.object({
  items: z.array(reelItemSchema),
  pagination: paginationSchema,
});

export const mobileTagsEnvelopeSchema = responseEnvelope(
  mobileTagsResponseSchema
);
export const mobileHomeEnvelopeSchema = responseEnvelope(mobileHomeDataSchema);
export const mobileSeriesEnvelopeSchema = responseEnvelope(
  mobileSeriesDataSchema
);
export const mobileReelsEnvelopeSchema = responseEnvelope(
  mobileReelsDataSchema
);

export const mobileHomeQuerySchema = z.object({
  tag: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  language_id: z.string().trim().optional(),
  limit: z.coerce.number().int().min(5).max(50).optional(),
  cursor: z.string().optional(),
});

export const mobileTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().uuid().optional(),
});

export const mobileSeriesParamsSchema = z.object({
  seriesId: z.string(),
});

export const mobileReelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(5).max(50).optional(),
  cursor: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
});

export type MobileTagsResponse = z.infer<typeof mobileTagsResponseSchema>;
export type MobileHomeData = z.infer<typeof mobileHomeDataSchema>;
export type MobileSeriesData = z.infer<typeof mobileSeriesDataSchema>;
export type MobileReelsData = z.infer<typeof mobileReelsDataSchema>;
export type MobileHomeQuery = z.infer<typeof mobileHomeQuerySchema>;
export type MobileTagsQuery = z.infer<typeof mobileTagsQuerySchema>;
export type MobileSeriesParams = z.infer<typeof mobileSeriesParamsSchema>;
export type MobileReelsQuery = z.infer<typeof mobileReelsQuerySchema>;
export type MobileTagsEnvelope = z.infer<typeof mobileTagsEnvelopeSchema>;
export type MobileHomeEnvelope = z.infer<typeof mobileHomeEnvelopeSchema>;
export type MobileSeriesEnvelope = z.infer<typeof mobileSeriesEnvelopeSchema>;
export type MobileReelsEnvelope = z.infer<typeof mobileReelsEnvelopeSchema>;
