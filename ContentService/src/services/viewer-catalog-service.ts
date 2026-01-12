import { MediaAssetStatus, Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  CatalogRepository,
  EpisodeWithRelations,
  SeriesWithRelations,
} from "../repositories/catalog-repository";
import type { CategoryListResponse } from "../schemas/viewer-catalog";
import { getCachedJson, setCachedJson } from "../utils/cache";
import { TrendingService } from "./trending-service";
import {
  DataQualityMonitor,
  type DataQualityContext,
} from "./data-quality-monitor";
import type { EngagementClient } from "../clients/engagement-client";

export type ViewerFeedItem = {
  id: string;
  slug: string;
  title: string;
  tags: string[];
  synopsis: string | null;
  heroImageUrl: string | null;
  defaultThumbnailUrl: string | null;
  durationSeconds: number;
  publishedAt: string;
  availability: {
    start: string | null;
    end: string | null;
  };
  season: {
    id: string;
    sequenceNumber: number;
    title: string | null;
  } | null;
  series: {
    id: string;
    slug: string;
    title: string;
    synopsis: string | null;
    heroImageUrl: string | null;
    bannerImageUrl: string | null;
    category: {
      id: string;
      slug: string;
      name: string;
    } | null;
  };
  playback: {
    status: MediaAssetStatus;
    manifestUrl: string | null;
    defaultThumbnailUrl: string | null;
    variants: Array<{
      label: string;
      width: number | null;
      height: number | null;
      bitrateKbps: number | null;
      codec: string | null;
      frameRate: number | null;
    }>;
  };
  localization: {
    captions: Array<{
      language: string;
      label?: string;
      url?: string;
    }>;
    availableLanguages: string[];
  };
  personalization: {
    reason: "trending" | "recent" | "viewer_following";
    score?: number;
  };
  ratings: {
    average: number | null;
  };
};

export type ViewerFeedResponse = {
  items: ViewerFeedItem[];
  nextCursor: string | null;
};

export type SeriesDetailResponse = {
  series: {
    id: string;
    slug: string;
    title: string;
    synopsis: string | null;
    heroImageUrl: string | null;
    bannerImageUrl: string | null;
    tags: string[];
    releaseDate: string | null;
    category: {
      id: string;
      slug: string;
      name: string;
    } | null;
  };
  seasons: Array<{
    id: string;
    sequenceNumber: number;
    title: string;
    synopsis: string | null;
    releaseDate: string | null;
    episodes: ViewerFeedItem[];
  }>;
  standaloneEpisodes: ViewerFeedItem[];
};

export type RelatedSeriesResponse = {
  items: Array<{
    id: string;
    slug: string;
    title: string;
    synopsis: string | null;
    heroImageUrl: string | null;
    bannerImageUrl: string | null;
    category: {
      id: string;
      slug: string;
      name: string;
    } | null;
  }>;
};

export type ViewerCatalogServiceOptions = {
  repository?: CatalogRepository;
  redis?: Redis;
  trending?: TrendingService;
  feedCacheTtlSeconds: number;
  seriesCacheTtlSeconds: number;
  relatedCacheTtlSeconds: number;
  qualityMonitor?: DataQualityMonitor;
  engagement?: EngagementClient;
};

const FEED_CACHE_PREFIX = "catalog:feed";
const SERIES_CACHE_PREFIX = "catalog:series";
const RELATED_CACHE_PREFIX = "catalog:related";

const tracer = trace.getTracer("content-service.viewer");

async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  run: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      return await run(span);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ episodeId: id })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) {
    return null;
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { episodeId?: string };
    return typeof parsed.episodeId === "string" ? parsed.episodeId : null;
  } catch {
    return null;
  }
}

function extractCaptions(
  captions: Prisma.JsonValue | null | undefined
): ViewerFeedItem["localization"]["captions"] {
  if (!captions || typeof captions !== "object") {
    return [];
  }
  return Object.entries(captions as Record<string, unknown>)
    .map(([language, value]) => {
      if (!value || typeof value !== "object") {
        return { language };
      }
      const payload = value as Record<string, unknown>;
      const entry: ViewerFeedItem["localization"]["captions"][number] = {
        language,
      };
      if (typeof payload.label === "string") {
        entry.label = payload.label;
      }
      if (typeof payload.url === "string") {
        entry.url = payload.url;
      }
      return entry;
    })
    .sort((a, b) => a.language.localeCompare(b.language));
}

export function buildFeedItem(
  episode: EpisodeWithRelations,
  personalization: ViewerFeedItem["personalization"],
  rating: number | null
): ViewerFeedItem {
  const captions = extractCaptions(episode.captions);
  const asset = episode.mediaAsset;
  return {
    id: episode.id,
    slug: episode.slug,
    title: episode.title,
    tags: episode.tags,
    synopsis: episode.synopsis ?? null,
    heroImageUrl: episode.heroImageUrl ?? episode.series.heroImageUrl ?? null,
    defaultThumbnailUrl:
      episode.defaultThumbnailUrl ?? asset?.defaultThumbnailUrl ?? null,
    durationSeconds: episode.durationSeconds,
    publishedAt: episode.publishedAt?.toISOString() ?? new Date().toISOString(),
    availability: {
      start: episode.availabilityStart?.toISOString() ?? null,
      end: episode.availabilityEnd?.toISOString() ?? null,
    },
    season: episode.season
      ? {
        id: episode.season.id,
        sequenceNumber: episode.season.sequenceNumber,
        title: episode.season.title ?? null,
      }
      : null,
    series: {
      id: episode.series.id,
      slug: episode.series.slug,
      title: episode.series.title,
      synopsis: episode.series.synopsis ?? null,
      heroImageUrl: episode.series.heroImageUrl ?? null,
      bannerImageUrl: episode.series.bannerImageUrl ?? null,
      category: episode.series.category
        ? {
          id: episode.series.category.id,
          slug: episode.series.category.slug,
          name: episode.series.category.name,
        }
        : null,
    },
    playback: {
      status: asset?.status ?? MediaAssetStatus.PENDING,
      manifestUrl: asset?.manifestUrl ?? null,
      defaultThumbnailUrl: asset?.defaultThumbnailUrl ?? null,
      variants:
        asset?.variants.map((variant) => ({
          label: variant.label,
          width: variant.width ?? null,
          height: variant.height ?? null,
          bitrateKbps: variant.bitrateKbps ?? null,
          codec: variant.codec ?? null,
          frameRate: variant.frameRate ?? null,
        })) ?? [],
    },
    localization: {
      captions,
      availableLanguages: captions.map((entry) => entry.language),
    },
    personalization,
    ratings: {
      average: rating,
    },
  };
}

export class ViewerCatalogService {
  private readonly repo: CatalogRepository;
  private readonly redis?: Redis;
  private readonly trending?: TrendingService;
  private readonly feedTtl: number;
  private readonly seriesTtl: number;
  private readonly relatedTtl: number;
  private readonly qualityMonitor?: DataQualityMonitor;
  private readonly engagement?: EngagementClient;

  constructor(options: ViewerCatalogServiceOptions) {
    this.repo = options.repository ?? new CatalogRepository();
    this.redis = options.redis;
    this.trending = options.trending;
    this.feedTtl = options.feedCacheTtlSeconds;
    this.seriesTtl = options.seriesCacheTtlSeconds;
    this.relatedTtl = options.relatedCacheTtlSeconds;
    this.qualityMonitor = options.qualityMonitor;
    this.engagement = options.engagement;
  }

  async getFeed(params: {
    viewerId?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<ViewerFeedResponse & { fromCache: boolean }> {
    return withSpan(
      "ViewerCatalogService.getFeed",
      {
        viewerId: params.viewerId ?? "anon",
        limit: params.limit ?? "default",
        cursor: params.cursor ?? "origin",
      },
      async (span) => {
        const cacheKey = this.buildFeedCacheKey(params);
        if (this.redis) {
          const cached = await getCachedJson<ViewerFeedResponse>(
            this.redis,
            cacheKey
          );
          if (cached) {
            span.setAttribute("cache.hit", true);
            return { ...cached, fromCache: true };
          }
        }

        const decodedCursor = decodeCursor(params.cursor);
        const repoResult = await this.repo.listFeedEpisodes({
          limit: params.limit,
          cursor: decodedCursor,
        });
        span.setAttribute("result.count", repoResult.items.length);

        const ids = repoResult.items.map((item) => item.id);
        const scores = this.trending
          ? await this.trending.getScores(ids)
          : new Map<string, number>();
        const ratings = this.trending
          ? await this.trending.getAverageRatings(ids)
          : new Map<string, number>();

        const items = repoResult.items.map((episode) => {
          this.ensureEpisodeQuality(episode, { source: "viewer.feed" });
          const score = scores.get(episode.id);
          const rating = ratings.get(episode.id) ?? null;
          const personalization: ViewerFeedItem["personalization"] = score
            ? { reason: "trending", score }
            : { reason: "recent" };
          return buildFeedItem(episode, personalization, rating);
        });

        const response: ViewerFeedResponse = {
          items,
          nextCursor: repoResult.nextCursor
            ? encodeCursor(repoResult.nextCursor)
            : null,
        };

        if (this.redis) {
          await setCachedJson(this.redis, cacheKey, response, this.feedTtl);
          span.setAttribute("cache.write", true);
        }

        return { ...response, fromCache: false };
      }
    );
  }

  async listCategories(params: {
    limit?: number;
    cursor?: string | null;
  }): Promise<CategoryListResponse> {
    return withSpan(
      "ViewerCatalogService.listCategories",
      {
        limit: params.limit ?? "default",
        cursor: params.cursor ?? "origin",
      },
      async () => {
        const result = await this.repo.listCategories({
          limit: params.limit,
          cursor: params.cursor ?? null,
        });
        return {
          items: result.items.map((category) => ({
            id: category.id,
            slug: category.slug,
            name: category.name,
            description: category.description ?? null,
            displayOrder: category.displayOrder ?? null,
          })),
          nextCursor: result.nextCursor,
        } satisfies CategoryListResponse;
      }
    );
  }

  async getSeriesDetail(params: {
    slug: string;
  }): Promise<(SeriesDetailResponse & { fromCache: boolean }) | null> {
    return withSpan(
      "ViewerCatalogService.getSeriesDetail",
      { slug: params.slug },
      async (span) => {
        const cacheKey = this.buildSeriesCacheKey(params.slug);
        if (this.redis) {
          const cached = await getCachedJson<SeriesDetailResponse>(
            this.redis,
            cacheKey
          );
          if (cached) {
            span.setAttribute("cache.hit", true);
            return { ...cached, fromCache: true };
          }
        }


        let series;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(params.slug)) {
          series = await this.repo.findSeriesForViewerById({
            id: params.slug,
          });
        } else {
          series = await this.repo.findSeriesForViewer({
            slug: params.slug,
          });
        }
        if (!series) {
          return null;
        }

        span.setAttribute("series.id", series.id);

        const seasonItems = series.seasons.map((season) => ({
          id: season.id,
          sequenceNumber: season.sequenceNumber,
          title: season.title,
          synopsis: season.synopsis ?? null,
          releaseDate: season.releaseDate?.toISOString() ?? null,
          episodes: season.episodes.map((episode) => {
            this.ensureEpisodeQuality(episode, { source: "viewer.series" });
            return buildFeedItem(episode, { reason: "viewer_following" }, null);
          }),
        }));

        const standaloneEpisodes = series.standaloneEpisodes.map((episode) => {
          this.ensureEpisodeQuality(episode, { source: "viewer.series" });
          return buildFeedItem(episode, { reason: "viewer_following" }, null);
        });

        const response: SeriesDetailResponse = {
          series: {
            id: series.id,
            slug: series.slug,
            title: series.title,
            synopsis: series.synopsis ?? null,
            heroImageUrl: series.heroImageUrl ?? null,
            bannerImageUrl: series.bannerImageUrl ?? null,
            tags: series.tags,
            releaseDate: series.releaseDate?.toISOString() ?? null,
            category: series.category
              ? {
                id: series.category.id,
                slug: series.category.slug,
                name: series.category.name,
              }
              : null,
          },
          seasons: seasonItems,
          standaloneEpisodes,
        };

        if (this.redis) {
          await setCachedJson(this.redis, cacheKey, response, this.seriesTtl);
          span.setAttribute("cache.write", true);
        }

        return { ...response, fromCache: false };
      }
    );
  }

  async getRelatedSeries(params: {
    slug: string;
    limit?: number;
  }): Promise<(RelatedSeriesResponse & { fromCache: boolean }) | null> {
    return withSpan(
      "ViewerCatalogService.getRelatedSeries",
      {
        slug: params.slug,
        limit: params.limit ?? "default",
      },
      async (span) => {
        const cacheKey = this.buildRelatedCacheKey(params.slug, params.limit);
        if (this.redis) {
          const cached = await getCachedJson<RelatedSeriesResponse>(
            this.redis,
            cacheKey
          );
          if (cached) {
            span.setAttribute("cache.hit", true);
            return { ...cached, fromCache: true };
          }
        }

        const series = await this.repo.findSeriesForViewer({
          slug: params.slug,
        });
        if (!series) {
          return null;
        }

        span.setAttribute("series.id", series.id);

        const related = await this.repo.listRelatedSeries({
          seriesId: series.id,
          categoryId: series.category?.id,
          limit: params.limit,
        });

        span.setAttribute("result.count", related.length);

        const response: RelatedSeriesResponse = {
          items: related.map((entry) => ({
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            synopsis: entry.synopsis ?? null,
            heroImageUrl: entry.heroImageUrl ?? null,
            bannerImageUrl: entry.bannerImageUrl ?? null,
            category: entry.category
              ? {
                id: entry.category.id,
                slug: entry.category.slug,
                name: entry.category.name,
              }
              : null,
          })),
        };

        if (this.redis) {
          await setCachedJson(this.redis, cacheKey, response, this.relatedTtl);
          span.setAttribute("cache.write", true);
        }

        return { ...response, fromCache: false };
      }
    );
  }

  async getSeriesById(params: {
    id: string;
  }): Promise<any> {
    return withSpan(
      "ViewerCatalogService.getSeriesById",
      { id: params.id },
      async (span) => {
        const series = await this.repo.findSeriesForViewerById({ id: params.id });
        if (!series) {
          return null;
        }

        let reviews = {
          summary: { average_rating: 0, total_reviews: 0 },
          user_reviews: [] as any[],
        };

        if (this.engagement) {
          try {
            const reviewData = await this.engagement.getReviews({
              seriesId: series.id,
              limit: 5,
            });
            reviews = {
              summary: reviewData.summary,
              user_reviews: reviewData.user_reviews,
            };
          } catch (error) {
            console.error("Failed to fetch reviews", error);
          }
        }

        const allEpisodes: ViewerFeedItem[] = [];

        series.seasons.forEach((season) => {
          season.episodes.forEach((episode) => {
            this.ensureEpisodeQuality(episode as unknown as EpisodeWithRelations, { source: "viewer.series_detail" });
            allEpisodes.push(buildFeedItem(episode as unknown as EpisodeWithRelations, { reason: "viewer_following" }, null));
          });
        });

        series.standaloneEpisodes.forEach((episode) => {
          this.ensureEpisodeQuality(episode, { source: "viewer.series_detail" });
          allEpisodes.push(buildFeedItem(episode, { reason: "viewer_following" }, null));
        });

        const response = {
          success: true,
          statusCode: 0,
          userMessage: "Series fetched successfully",
          developerMessage: "Success",
          data: {
            series_id: series.id,
            series_title: series.title,
            synopsis: series.synopsis ?? "",
            thumbnail: series.heroImageUrl ?? "",
            banner: series.bannerImageUrl ?? "",
            tags: series.tags,
            category: series.category?.name ?? "Uncategorized",
            trailer: {
              thumbnail: series.heroImageUrl ?? "",
              duration_seconds: 0,
              streaming: {
                can_watch: true,
                plan_purchased: true,
                type: "hls",
                master_playlist: "",
                qualities: []
              }
            },
            episodes: allEpisodes.map(ep => ({
              series_id: series.id,
              episode_id: ep.id,
              episode: ep.season?.sequenceNumber ?? 0,
              season: ep.season?.sequenceNumber ?? 0,
              title: ep.title,
              description: ep.synopsis ?? "",
              thumbnail: ep.defaultThumbnailUrl ?? "",
              duration_seconds: ep.durationSeconds,
              release_date: ep.publishedAt,
              is_download_allowed: true,
              rating: ep.ratings.average ?? 0,
              views: 0,
              streaming: {
                can_watch: true,
                plan_purchased: true,
                type: "hls",
                master_playlist: ep.playback.manifestUrl ?? "",
                qualities: ep.playback.variants.map(v => ({
                  quality: v.label,
                  bitrate: v.bitrateKbps?.toString() ?? "0",
                  resolution: `${v.width}x${v.height}`,
                  size_mb: 0,
                  url: ""
                }))
              },
              progress: {
                watched_duration: 0,
                total_duration: ep.durationSeconds,
                percentage: 0,
                last_watched_at: new Date().toISOString(),
                is_completed: false
              }
            })),
            reviews: reviews
          }
        };

        return response;
      }
    );
  }

  async getEpisodeMetadata(id: string): Promise<ViewerFeedItem | null> {
    return withSpan(
      "ViewerCatalogService.getEpisodeMetadata",
      { episodeId: id },
      async () => {
        const episode = await this.repo.findEpisodeForViewer(id);
        if (!episode) {
          return null;
        }
        this.ensureEpisodeQuality(episode, { source: "internal.lookup" });
        return buildFeedItem(episode, { reason: "recent" }, null);
      }
    );
  }

  private buildFeedCacheKey(params: {
    viewerId?: string;
    limit?: number;
    cursor?: string | null;
  }): string {
    const viewer = params.viewerId ?? "anon";
    const limit = params.limit ?? "default";
    const cursor = params.cursor ?? "origin";
    return `${FEED_CACHE_PREFIX}:${viewer}:${limit}:${cursor}`;
  }

  private buildSeriesCacheKey(slug: string): string {
    return `${SERIES_CACHE_PREFIX}:${slug}`;
  }

  private buildRelatedCacheKey(slug: string, limit?: number): string {
    return `${RELATED_CACHE_PREFIX}:${slug}:${limit ?? "default"}`;
  }

  private ensureEpisodeQuality(
    episode: EpisodeWithRelations,
    context: DataQualityContext
  ) {
    this.qualityMonitor?.ensureEpisodeConsistency(episode, context);
  }
}
