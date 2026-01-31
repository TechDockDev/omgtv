import { MediaAssetStatus } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  CatalogRepository,
  type CarouselEntryWithContent,
  type ReelWithRelations,
} from "../repositories/catalog-repository";
import {
  ViewerCatalogService,
  buildFeedItem,
  type ViewerFeedItem,
  type SeriesDetailResponse,
} from "./viewer-catalog-service";
import {
  EngagementClient,
  type ContinueWatchEntry,
} from "../clients/engagement-client";
import {
  SubscriptionClient,
  type ContentEntitlement,
} from "../clients/subscription-client";
import {
  mobileHomeDataSchema,
  mobileHomeQuerySchema,
  mobileReelsDataSchema,
  mobileReelsQuerySchema,
  mobileSeriesDataSchema,
  mobileSeriesParamsSchema,
  mobileTagsQuerySchema,
  mobileTagsResponseSchema,
  streamingInfoSchema,
  type MobileHomeData,
  type MobileHomeQuery,
  type MobileReelsData,
  type MobileReelsQuery,
  type MobileSeriesData,
  type MobileSeriesParams,
  type MobileTagsQuery,
  type MobileTagsResponse,
} from "../schemas/mobile-app";

type LoggerLike = Pick<FastifyBaseLogger, "error" | "warn">;

export type MobileRequestContext = {
  userId?: string;
  userType?: string;
  roles?: string[];
  languageId?: string;
};

export type MobileRequestOptions = {
  context?: MobileRequestContext;
  logger?: LoggerLike;
};

type PlaybackLike = {
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

type CarouselEntryView = {
  id: string;
  priority: number;
  type: string;
  title: string;
  subtitle: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  rating: number | null;
  series_id: string | null;
  engagement?: {
    likeCount: number;
    viewCount: number;
    isLiked: boolean;
    isSaved: boolean;
    averageRating: number;
    reviewCount: number;
  } | null;
};

export type MobileAppConfig = {
  homeFeedLimit: number;
  carouselLimit: number;
  continueWatchLimit: number;
  sectionItemLimit: number;
  defaultPlanPurchased: boolean;
  defaultGuestCanWatch: boolean;
  streamingType: string;
  reelsPageSize: number;
};

type EntitlementSnapshot = {
  canWatch: boolean;
  planPurchased: boolean;
};

type EntitlementLookup = {
  episode: EntitlementSnapshot;
  reel: EntitlementSnapshot;
};

export class MobileAppService {
  constructor(
    private readonly deps: {
      viewerCatalog: ViewerCatalogService;
      repository: CatalogRepository;
      config: MobileAppConfig;
      engagementClient?: EngagementClient;
      subscriptionClient?: SubscriptionClient;
    }
  ) { }

  async listTags(query: MobileTagsQuery): Promise<MobileTagsResponse> {
    const parsed = mobileTagsQuerySchema.parse(query);
    const result = await this.deps.repository.listTags({
      limit: parsed.limit,
      cursor: parsed.cursor ?? null,
    });

    const tags = result.items.map((tag, index) => ({
      id: tag.id,
      name: tag.name,
      order: index + 1,
      slug: tag.slug,
    }));

    const payload: MobileTagsResponse = {
      tags,
      pagination: {
        nextCursor: result.nextCursor,
      },
    };

    return mobileTagsResponseSchema.parse(payload);
  }

  async getHomeExperience(
    query: MobileHomeQuery,
    options?: MobileRequestOptions
  ): Promise<{ data: MobileHomeData; fromCache: boolean }> {
    const parsed = mobileHomeQuerySchema.parse(query);

    // Fetch Series for Sections (Main Content) and Episodes for Continue Watch (Resume)
    const [seriesFeed, episodeFeed, topTen] = await Promise.all([
      this.deps.viewerCatalog.getHomeSeries({
        limit: parsed.limit ?? this.deps.config.homeFeedLimit,
        cursor: parsed.cursor,
      }),
      this.deps.viewerCatalog.getFeed({
        limit: this.deps.config.continueWatchLimit * 2,
        cursor: null,
      }),
      this.deps.repository.getTopTenSeries(),
    ]);

    options?.logger?.warn({
      msg: "[MobileHub] Debug Stats",
      series: seriesFeed.items.length,
      episodes: episodeFeed.items.length,
      topTen: topTen.length,
    });

    const filteredItems = this.filterByTag(seriesFeed.items, parsed.tag);
    const entitlements = await this.resolveEntitlements(options);

    const progressMap = await this.loadProgressMap(episodeFeed.items, {
      limit: this.deps.config.continueWatchLimit * 4,
      options,
    });

    // Load engagement for Series (Sections) AND Top 10
    const engagementItems: Array<{ id: string; contentType: "reel" | "series" }> =
      filteredItems.map((item) => ({ id: item.id, contentType: "series" as const }));

    topTen.forEach((t) => {
      engagementItems.push({ id: t.series.id, contentType: "series" as const });
    });

    const engagementStates = await this.loadEngagementStates(engagementItems, options);

    const carouselItems = await this.buildCarouselItems(filteredItems, engagementStates);

    const top10Items = topTen.map((t) => {
      const engagement = engagementStates.get(t.series.id);
      return {
        id: t.series.id,
        type: "series",
        title: t.series.title,
        subtitle: t.series.category?.name ?? null,
        thumbnailUrl: t.series.heroImageUrl ?? t.series.bannerImageUrl ?? null,
        duration: null,
        watchedDuration: null,
        progress: null,
        rating: engagement?.averageRating ?? null,
        lastWatchedAt: null,
        series_id: t.series.id,
        engagement: engagement ?? null,
      };
    });

    // Build Continue Watch from Episode Feed
    const continueWatchCandidates = episodeFeed.items.filter((item) => progressMap.has(item.id));
    const continueWatch = continueWatchCandidates
      .slice(0, this.deps.config.continueWatchLimit)
      .map((item) => {
        return {
          ...this.toContinueWatchItem(
            item,
            entitlements.episode,
            progressMap.get(item.id)
          ),
          engagement: null,
        };
      });

    const sections = this.buildSections(
      filteredItems.map(item => {
        const engagement = engagementStates.get(item.id);
        return {
          ...this.toSectionEntry(item, undefined, engagement?.averageRating),
          engagement: engagement ?? null
        };
      }),
      continueWatch,
      parsed.tag
    );

    const currentPage = parsed.page ?? 1;
    const hasNextPage = Boolean(seriesFeed.nextCursor);

    const data: MobileHomeData = {
      carousel: carouselItems,
      top10: top10Items,
      "continue watch": continueWatch,
      sections,
      pagination: {
        currentPage,
        totalPages: hasNextPage ? currentPage + 1 : currentPage,
        hasNextPage,
        nextCursor: seriesFeed.nextCursor ?? null,
      },
    };

    return {
      data: mobileHomeDataSchema.parse(data),
      fromCache: seriesFeed.fromCache,
    };
  }

  async getAudioExperience(
    query: MobileHomeQuery,
    options?: MobileRequestOptions
  ): Promise<{ data: MobileHomeData; fromCache: boolean }> {
    const parsed = mobileHomeQuerySchema.parse(query);

    // Fetch Audio Series
    const seriesFeed = await this.deps.viewerCatalog.getAudioSeries({
      limit: parsed.limit ?? this.deps.config.homeFeedLimit,
      cursor: parsed.cursor,
    });

    const filteredItems = this.filterByTag(seriesFeed.items, parsed.tag);
    // Audio series don't usually have "continue watch" episodes in the same way, 
    // or maybe they do? For now, let's keep it simple and just show the series list.
    // If we want continue watch for audio, we'd need to fetch episodes. 
    // Let's assume audio series behave like normal series for now.

    const engagementItems: Array<{ id: string; contentType: "reel" | "series" }> =
      filteredItems.map((item) => ({ id: item.id, contentType: "series" as const }));
    const engagementStates = await this.loadEngagementStates(engagementItems, options);

    const sections = this.buildSections(
      filteredItems.map(item => {
        const engagement = engagementStates.get(item.id);
        return {
          ...this.toSectionEntry(item, undefined, engagement?.averageRating),
          engagement: engagement ?? null
        };
      }),
      [], // No continue watch for now
      parsed.tag
    );

    const currentPage = parsed.page ?? 1;
    const hasNextPage = Boolean(seriesFeed.nextCursor);

    const data: MobileHomeData = {
      // carousel: undefined, // Removed for audio experience
      "continue watch": [],
      sections,
      pagination: {
        currentPage,
        totalPages: hasNextPage ? currentPage + 1 : currentPage,
        hasNextPage,
        nextCursor: seriesFeed.nextCursor ?? null,
      },
    };

    return {
      data: mobileHomeDataSchema.parse(data),
      fromCache: seriesFeed.fromCache,
    };
  }

  async getSeriesDetail(
    params: MobileSeriesParams,
    options?: MobileRequestOptions
  ): Promise<MobileSeriesData | null> {
    const parsed = mobileSeriesParamsSchema.parse(params);
    const detail = await this.deps.viewerCatalog.getSeriesDetail({
      slug: parsed.seriesId,
    });

    if (!detail) {
      return null;
    }

    const entitlements = await this.resolveEntitlements(options);
    const allEpisodes = [
      ...detail.seasons.flatMap((season) => season.episodes),
      ...detail.standaloneEpisodes,
    ];
    const progressMap = await this.loadProgressMap(allEpisodes, {
      options,
      limit: 200,
    });

    // Load engagement states for series and all episodes
    const engagementItems: Array<{ id: string; contentType: "reel" | "series" }> = [
      { id: detail.series.id, contentType: "series" },
      ...allEpisodes.map((ep) => ({ id: ep.id, contentType: "reel" as const })),
    ];
    const engagementStates = await this.loadEngagementStates(engagementItems, options);

    // Fetch user reviews list
    const reviewsData = await this.deps.engagementClient?.getReviews({
      seriesId: detail.series.id,
      limit: 20
    }).catch(err => {
      options?.logger?.error({ err, seriesId: detail.series.id }, "Failed to fetch reviews");
      return {
        summary: { average_rating: 0, total_reviews: 0 },
        user_reviews: [],
        next_cursor: null
      };
    }) ?? {
      summary: { average_rating: 0, total_reviews: 0 },
      user_reviews: [],
      next_cursor: null
    };

    const data = this.buildSeriesPayload(detail, {
      entitlements,
      progressMap,
      engagementStates,
      reviews: reviewsData,
      logger: options?.logger
    });
    return mobileSeriesDataSchema.parse(data);
  }

  async listReels(
    query: MobileReelsQuery,
    options?: MobileRequestOptions
  ): Promise<MobileReelsData> {
    const parsed = mobileReelsQuerySchema.parse(query);
    const result = await this.deps.repository.listPublishedReels({
      limit: parsed.limit ?? this.deps.config.reelsPageSize,
      cursor: parsed.cursor ?? null,
    });

    const entitlements = await this.resolveEntitlements(options);

    // Load engagement states for all reels
    const engagementStates = await this.loadEngagementStates(
      result.items.map((reel) => ({ id: reel.id, contentType: "reel" as const })),
      options
    );

    const items = result.items.map((reel) => {
      const engagement = engagementStates.get(reel.id);
      const item = this.toReelItem(reel, entitlements.reel, engagement?.averageRating);
      return {
        ...item,
        engagement: engagement ?? null,
      };
    });

    const currentPage = parsed.page ?? 1;
    const hasNextPage = Boolean(result.nextCursor);

    const data: MobileReelsData = {
      items,
      pagination: {
        currentPage,
        totalPages: hasNextPage ? currentPage + 1 : currentPage,
        hasNextPage,
        nextCursor: result.nextCursor ?? null,
      },
    };

    return mobileReelsDataSchema.parse(data);
  }

  private async buildCarouselItems(
    feedItems: ViewerFeedItem[],
    engagementStates?: Map<
      string,
      { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
    >
  ): Promise<CarouselEntryView[]> {
    const limit = this.deps.config.carouselLimit;
    const entries = await this.deps.repository.listCarouselEntries();
    if (entries.length === 0) {
      return [];
    }

    const curated = this.formatCuratedCarouselEntries(entries, engagementStates);
    if (curated.length === 0) {
      return [];
    }

    const trimmed = curated.slice(0, limit);
    return trimmed;


  }

  private formatCuratedCarouselEntries(
    entries: CarouselEntryWithContent[],
    engagementStates?: Map<
      string,
      { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
    >
  ): CarouselEntryView[] {
    const items: CarouselEntryView[] = [];
    for (const entry of entries) {
      if (entry.episode) {
        const feedItem = buildFeedItem(
          entry.episode,
          { reason: "recent" },
          null
        );
        const engagement = engagementStates?.get(feedItem.series.id);
        items.push({
          ...this.toCarouselItem(feedItem, entry.position, engagement?.averageRating),
          engagement: engagement ?? null,
        });
        continue;
      }
      if (entry.series) {
        const engagement = engagementStates?.get(entry.series.id);
        items.push({
          ...this.toSeriesCarouselItem(entry.series, entry.position, engagement?.averageRating),
          engagement: engagement ?? null,
        });
      }
    }
    return items.sort((a, b) => a.priority - b.priority);
  }

  private toSeriesCarouselItem(
    series: NonNullable<CarouselEntryWithContent["series"]>,
    priority: number,
    engagementRating?: number | null
  ): CarouselEntryView {
    return {
      id: series.id,
      priority,
      type: "series",
      title: series.title,
      subtitle: series.category?.name ?? null,
      thumbnailUrl: series.heroImageUrl ?? series.bannerImageUrl ?? null,
      videoUrl: null,
      rating: engagementRating ?? null,
      series_id: series.id,
    } satisfies CarouselEntryView;
  }

  private filterByTag(items: ViewerFeedItem[], tag?: string) {
    if (!tag) {
      return items;
    }
    const normalized = tag.trim().toLowerCase();
    return items.filter((item) => {
      const categoryMatch =
        item.series.category?.slug?.toLowerCase() === normalized ||
        item.series.category?.name?.toLowerCase() === normalized;
      const tagMatch = item.tags.some(
        (episodeTag) => episodeTag.toLowerCase() === normalized
      );
      return categoryMatch || tagMatch;
    });
  }

  private toCarouselItem(
    item: ViewerFeedItem,
    priority: number,
    engagementRating?: number | null,
    type = "featured"
  ): CarouselEntryView {
    return {
      id: item.id,
      priority,
      type,
      title: item.title,
      subtitle: this.buildSubtitle(item),
      thumbnailUrl: item.heroImageUrl ?? item.defaultThumbnailUrl,
      videoUrl: item.playback.manifestUrl,
      rating: engagementRating ?? item.ratings.average,
      series_id: item.series.id,
    } satisfies CarouselEntryView;
  }

  private toContinueWatchItem(
    item: ViewerFeedItem,
    entitlement: EntitlementSnapshot,
    progress?: ContinueWatchEntry
  ) {
    const streaming = this.buildStreamingInfo(
      item.playback,
      item.durationSeconds,
      entitlement
    );
    const watchedDuration = progress
      ? Math.min(progress.watched_duration, item.durationSeconds)
      : 0;
    const totalDuration = progress?.total_duration
      ? Math.max(progress.total_duration, 1)
      : item.durationSeconds;
    const percentage = totalDuration
      ? Number((watchedDuration / totalDuration).toFixed(2))
      : 0;
    return {
      series_id: item.series.id,
      episode_id: item.id,
      episode: null,
      series_title: item.series.title,
      title: item.title,
      thumbnail:
        item.defaultThumbnailUrl ??
        item.playback.defaultThumbnailUrl ??
        item.heroImageUrl,
      duration_seconds: item.durationSeconds,
      streaming,
      progress: {
        watched_duration: watchedDuration,
        total_duration: totalDuration,
        percentage,
        last_watched_at: progress?.last_watched_at ?? null,
        is_completed: progress?.is_completed ?? false,
      },
      rating: item.ratings.average,
    };
  }

  private toSectionEntry(
    item: ViewerFeedItem,
    progress?: ContinueWatchEntry,
    engagementRating?: number | null
  ) {
    const watchedSeconds = progress
      ? Math.min(progress.watched_duration, item.durationSeconds)
      : 0;
    const totalDuration = progress?.total_duration ?? item.durationSeconds;
    const progressRatio = totalDuration
      ? Math.min(1, watchedSeconds / totalDuration)
      : 0;
    return {
      id: item.id,
      type: "episode",
      title: item.title,
      subtitle: this.buildSubtitle(item),
      thumbnailUrl:
        item.defaultThumbnailUrl ??
        item.playback.defaultThumbnailUrl ??
        item.heroImageUrl,
      duration: this.formatDuration(item.durationSeconds),
      watchedDuration: this.formatDuration(watchedSeconds),
      progress: progressRatio,
      rating: engagementRating ?? item.ratings.average,
      lastWatchedAt: progress?.last_watched_at ?? null,
      series_id: item.series.id,
      // Internal fields for grouping
      _categoryName: item.series.category?.name ?? null,
      _seriesTitle: item.series.title,
      _seriesThumbnail: item.series.heroImageUrl ?? item.series.bannerImageUrl ?? item.heroImageUrl,
    };
  }

  private buildSections(
    featured: ReturnType<MobileAppService["toSectionEntry"]>[],
    continueWatch: ReturnType<MobileAppService["toContinueWatchItem"]>[],
    tag?: string
  ) {
    const sections = [] as MobileHomeData["sections"];

    // 1. Continue Watch Section
    if (continueWatch.length > 0) {
      sections.push({
        id: "section_continue_watch",
        type: "continue_watch",
        title: "Continue Watch",
        priority: 1,
        items: continueWatch.map((entry) => ({
          id: entry.episode_id,
          type: "episode",
          title: entry.title,
          subtitle: entry.series_title,
          thumbnailUrl: entry.thumbnail,
          duration: this.formatDuration(entry.duration_seconds),
          watchedDuration: this.formatDuration(entry.progress.watched_duration),
          progress:
            entry.progress.total_duration > 0
              ? entry.progress.watched_duration / entry.progress.total_duration
              : 0,
          rating: entry.rating,
          lastWatchedAt: entry.progress.last_watched_at,
          series_id: entry.series_id,
        })),
      });
    }

    if (tag) {
      // If filtering by specific tag, return flat list as "Category" type section
      if (featured.length > 0) {
        sections.push({
          id: `section_${tag.toLowerCase()}`,
          type: "category",
          title: tag.replace(/\b\w/g, (c) => c.toUpperCase()),
          priority: sections.length + 1,
          items: featured.map(item => this.cleanSectionItem(item)),
        });
      }
      return sections;
    }

    // 2. Group by Category (Internal Grouping Logic)
    const categoryGroups = new Map<string, typeof featured>();
    const FALLBACK_CATEGORY = "All Shows";

    featured.forEach(item => {
      const category = item._categoryName || FALLBACK_CATEGORY;
      if (!categoryGroups.has(category)) {
        categoryGroups.set(category, []);
      }
      categoryGroups.get(category)!.push(item);
    });

    // 3. Build Sections from Groups (Deduplicating Series)
    // We iterate through known categories or just map entries?
    // Sort keys to ensure deterministic order? Or just use insertion order?
    // Let's use specific order: Categories first, then All Shows.
    const keys = Array.from(categoryGroups.keys()).sort((a, b) => {
      if (a === FALLBACK_CATEGORY) return 1; // All Shows last
      if (b === FALLBACK_CATEGORY) return -1;
      return a.localeCompare(b);
    });

    keys.forEach(categoryName => {
      const items = categoryGroups.get(categoryName)!;
      const uniqueSeries = new Map<string, any>();

      items.forEach(item => {
        // Deduplicate by Series ID
        // We want to show the SERIES, not the Episode.
        // So we transform the entry to look like a Series Entry.
        if (!uniqueSeries.has(item.series_id)) {
          uniqueSeries.set(item.series_id, {
            ...item,
            type: "series", // Change type to series
            id: item.series_id, // Use Series ID
            title: item._seriesTitle, // Use Series Title
            subtitle: null, // Clear subtitle or put Category? Category is in section header.
            thumbnailUrl: item._seriesThumbnail, // Use Series Thumbnail
            // Clear episode specific fields
            duration: null,
            watchedDuration: null,
            progress: null,
            lastWatchedAt: null,
          });
        }
      });

      if (uniqueSeries.size > 0) {
        sections.push({
          id: `section_${categoryName.toLowerCase().replace(/\s+/g, "_")}`,
          type: "category",
          title: categoryName,
          priority: sections.length + 1,
          items: Array.from(uniqueSeries.values()).map(item => this.cleanSectionItem(item)),
        });
      }
    });

    return sections;
  }

  private cleanSectionItem(item: ReturnType<MobileAppService["toSectionEntry"]>) {
    // Remove internal fields before returning to Zod
    const { _categoryName, _seriesTitle, _seriesThumbnail, ...rest } = item;
    return rest;
  }

  private buildSeriesPayload(
    detail: SeriesDetailResponse,
    options: {
      entitlements: EntitlementLookup;
      progressMap: Map<string, ContinueWatchEntry>;
      engagementStates?: Map<
        string,
        { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
      >;
      logger: LoggerLike | undefined;
      reviews: { summary: any; user_reviews: any[] } | null;
    }
  ): MobileSeriesData {
    const episodes = this.flattenEpisodes(detail, options);
    const ratings = episodes
      .map((episode) => episode.rating ?? null)
      .filter((value): value is number => value !== null);
    const averageRating =
      ratings.length > 0
        ? Number(
          (
            ratings.reduce((total, value) => total + value, 0) /
            ratings.length
          ).toFixed(1)
        )
        : null;

    const trailerSource = episodes[0];
    const seriesEngagement = options.engagementStates?.get(detail.series.id);

    return {
      series_id: detail.series.id,
      series_title: detail.series.title,
      synopsis: detail.series.synopsis,
      thumbnail: detail.series.heroImageUrl,
      banner: detail.series.bannerImageUrl,
      tags: detail.series.tags,
      category: detail.series.category?.name ?? null,
      trailer: trailerSource
        ? {
          thumbnail: trailerSource.thumbnail,
          duration_seconds: trailerSource.duration_seconds,
          streaming: trailerSource.streaming,
        }
        : null,
      episodes,
      rating: seriesEngagement?.averageRating ?? null,
      engagement: seriesEngagement ?? null,
      reviews: {
        summary: {
          average_rating: options.reviews?.summary.average_rating ?? averageRating,
          total_reviews: options.reviews?.summary.total_reviews ?? ratings.length,
        },
        user_reviews:
          options.reviews?.user_reviews.map((r) => ({
            review_id: r.review_id,
            user_id: r.user_id,
            user_name: r.user_name,
            user_phone: r.user_phone,
            rating: r.rating,
            comment: r.comment,
            created_at: r.created_at,
            title: null,
          })) ?? [],
      },
    };
  }

  private flattenEpisodes(
    detail: SeriesDetailResponse,
    options: {
      entitlements: EntitlementLookup;
      progressMap: Map<string, ContinueWatchEntry>;
      engagementStates?: Map<
        string,
        { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
      >;
    }
  ): MobileSeriesData["episodes"] {
    const entries: MobileSeriesData["episodes"] = [];

    detail.seasons.forEach((season) => {
      season.episodes.forEach((episode, idx) => {
        const engagement = options.engagementStates?.get(episode.id);
        entries.push({
          ...this.toSeriesEpisode(
            episode,
            season.sequenceNumber,
            idx + 1,
            options.entitlements.episode,
            options.progressMap.get(episode.id),
            engagement?.averageRating
          ),
          engagement: engagement ?? null,
        });
      });
    });

    detail.standaloneEpisodes.forEach((episode, idx) => {
      const engagement = options.engagementStates?.get(episode.id);
      entries.push({
        ...this.toSeriesEpisode(
          episode,
          null,
          idx + 1,
          options.entitlements.episode,
          options.progressMap.get(episode.id),
          engagement?.averageRating
        ),
        engagement: engagement ?? null,
      });
    });

    return entries;
  }

  private toSeriesEpisode(
    episode: ViewerFeedItem,
    seasonNumber: number | null,
    episodeIndex: number,
    entitlement: EntitlementSnapshot,
    progress?: ContinueWatchEntry,
    engagementRating?: number | null
  ) {
    const streaming = this.buildStreamingInfo(
      episode.playback,
      episode.durationSeconds,
      entitlement
    );
    const watchedDuration = progress
      ? Math.min(progress.watched_duration, episode.durationSeconds)
      : 0;
    const totalDuration = progress?.total_duration ?? episode.durationSeconds;
    const percentage = totalDuration
      ? Number((watchedDuration / totalDuration).toFixed(2))
      : 0;
    return {
      series_id: episode.series.id,
      episode_id: episode.id,
      episode: episodeIndex,
      season: seasonNumber,
      title: episode.title,
      description: episode.synopsis,
      thumbnail:
        episode.defaultThumbnailUrl ??
        episode.playback.defaultThumbnailUrl ??
        episode.heroImageUrl,
      duration_seconds: episode.durationSeconds,
      release_date: episode.publishedAt,
      is_download_allowed: episode.playback.status === MediaAssetStatus.READY,
      rating: engagementRating ?? episode.ratings.average,
      views: null,
      streaming,
      progress: {
        watched_duration: watchedDuration,
        total_duration: totalDuration,
        percentage,
        last_watched_at: progress?.last_watched_at ?? null,
        is_completed: progress?.is_completed ?? false,
      },
    };
  }

  private toReelItem(
    reel: ReelWithRelations,
    entitlement: EntitlementSnapshot,
    engagementRating?: number | null
  ) {
    const streaming = this.buildStreamingInfo(
      {
        status: reel.mediaAsset?.status ?? MediaAssetStatus.PENDING,
        manifestUrl: reel.mediaAsset?.manifestUrl ?? null,
        defaultThumbnailUrl: reel.mediaAsset?.defaultThumbnailUrl ?? null,
        variants: (reel.mediaAsset?.variants ?? []).map((variant) => ({
          label: variant.label,
          width: variant.width ?? null,
          height: variant.height ?? null,
          bitrateKbps: variant.bitrateKbps ?? null,
          codec: variant.codec ?? null,
          frameRate: variant.frameRate ?? null,
        })),
      },
      reel.durationSeconds,
      entitlement
    );

    return {
      id: reel.id,
      title: reel.title,
      description: reel.description ?? null,
      duration_seconds: reel.durationSeconds,
      rating: engagementRating ?? null,
      thumbnail: reel.mediaAsset?.defaultThumbnailUrl ?? null,
      streaming,
      series: reel.series
        ? {
          id: reel.series.id,
          title: reel.series.title,
          thumbnail: reel.series.heroImageUrl ?? reel.series.bannerImageUrl ?? null,
        }
        : null,
      episode: reel.episode
        ? {
          id: reel.episode.id,
          slug: reel.episode.slug,
          episodeNumber: reel.episode.episodeNumber ?? null,
        }
        : null,
    };
  }

  private buildSubtitle(item: ViewerFeedItem) {
    const category = item.series.category?.name;
    if (category) {
      return `${item.series.title} • ${category}`;
    }
    return item.series.title;
  }

  private formatDuration(durationSeconds: number) {
    const minutes = Math.floor(durationSeconds / 60)
      .toString()
      .padStart(2, "0");
    const seconds = Math.floor(durationSeconds % 60)
      .toString()
      .padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  private buildStreamingInfo(
    playback: PlaybackLike,
    durationSeconds: number,
    entitlement?: EntitlementSnapshot
  ) {

    const assetReady =
      playback.status === MediaAssetStatus.READY &&
      Boolean(playback.manifestUrl);
    const entitlementCanWatch =
      entitlement?.canWatch ?? this.deps.config.defaultGuestCanWatch;
    const variants = playback.variants.length
      ? playback.variants
      : [
        {
          label: "auto",
          width: null,
          height: null,
          bitrateKbps: null,
          codec: null,
          frameRate: null,
        },
      ];

    const qualities = variants.map((variant) => ({
      quality: variant.label,
      bitrate: variant.bitrateKbps ? `${variant.bitrateKbps}k` : null,
      resolution:
        variant.width && variant.height
          ? `${variant.width}x${variant.height}`
          : null,
      size_mb: this.estimateSizeMb(variant.bitrateKbps, durationSeconds),
      url: playback.manifestUrl,
    }));

    return streamingInfoSchema.parse({
      can_watch: assetReady ? entitlementCanWatch : false,
      plan_purchased:
        entitlement?.planPurchased ?? this.deps.config.defaultPlanPurchased,
      type: this.deps.config.streamingType,
      master_playlist: playback.manifestUrl,
      qualities,
    });
  }

  private async resolveEntitlements(
    options?: MobileRequestOptions
  ): Promise<EntitlementLookup> {
    const fallback: EntitlementSnapshot = {
      canWatch: this.deps.config.defaultGuestCanWatch,
      planPurchased: this.deps.config.defaultPlanPurchased,
    };

    const userId = options?.context?.userId;
    if (!userId || !this.deps.subscriptionClient) {
      return { episode: fallback, reel: fallback };
    }

    try {
      const [episode, reel] = await Promise.all([
        this.deps.subscriptionClient.checkEntitlement({
          userId,
          contentType: "EPISODE",
        }),
        this.deps.subscriptionClient.checkEntitlement({
          userId,
          contentType: "REEL",
        }),
      ]);

      return {
        episode: this.toEntitlementSnapshot(episode) ?? fallback,
        reel: this.toEntitlementSnapshot(reel) ?? fallback,
      } satisfies EntitlementLookup;
    } catch (error) {
      options?.logger?.warn?.(
        { err: error },
        "Failed to resolve subscription entitlements"
      );
      return { episode: fallback, reel: fallback };
    }
  }

  private toEntitlementSnapshot(
    result?: ContentEntitlement
  ): EntitlementSnapshot | undefined {
    if (!result) {
      return undefined;
    }
    return {
      canWatch: result.canWatch,
      planPurchased: result.planPurchased,
    } satisfies EntitlementSnapshot;
  }

  private async loadProgressMap(
    items: ViewerFeedItem[],
    params: { limit?: number; options?: MobileRequestOptions }
  ): Promise<Map<string, ContinueWatchEntry>> {
    if (!this.deps.engagementClient) {
      return new Map();
    }
    const userId = params.options?.context?.userId;
    if (!userId) {
      return new Map();
    }

    const uniqueEpisodeIds = Array.from(new Set(items.map((item) => item.id)));
    const limit = params.limit ?? 100;
    const episodeIds = uniqueEpisodeIds.slice(0, limit);
    if (episodeIds.length === 0) {
      return new Map();
    }

    try {
      const entries = await this.deps.engagementClient.getContinueWatch({
        userId,
        episodeIds,
        limit: episodeIds.length,
      });
      return new Map(entries.map((entry) => [entry.episode_id, entry]));
    } catch (error) {
      params.options?.logger?.warn?.(
        { err: error },
        "Failed to fetch engagement progress"
      );
      return new Map();
    }
  }

  private estimateSizeMb(
    bitrateKbps: number | null | undefined,
    durationSeconds: number
  ) {
    if (!bitrateKbps || bitrateKbps <= 0) {
      return null;
    }
    const bitsPerSecond = bitrateKbps * 1000;
    const totalBits = bitsPerSecond * durationSeconds;
    const totalBytes = totalBits / 8;
    const totalMb = totalBytes / (1024 * 1024);
    return Math.round(totalMb);
  }

  private async loadEngagementStates(
    items: Array<{ id: string; contentType: "reel" | "series" }>,
    options?: MobileRequestOptions
  ): Promise<
    Map<
      string,
      { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
    >
  > {
    if (!this.deps.engagementClient) {
      return new Map();
    }

    const userId = options?.context?.userId?.toLowerCase();

    if (!userId || items.length === 0) {
      options?.logger?.warn({
        msg: "[MobileHub] Early Return (No Engagement)",
        userId,
        items: items.length
      });
      return new Map();
    }

    try {
      const states = await this.deps.engagementClient.getUserState({
        userId,
        items: items.map((item) => ({
          contentType: item.contentType,
          contentId: item.id,
        })),
      });

      options?.logger?.warn({
        msg: "[MobileHub] Engagement Response",
        reqUserId: userId,
        itemCount: items.length,
        resKeys: Object.keys(states)
      });

      // Convert to Map keyed by item id
      const result = new Map<
        string,
        { likeCount: number; viewCount: number; isLiked: boolean; isSaved: boolean; averageRating: number; reviewCount: number }
      >();

      for (const item of items) {
        const key = `${item.contentType}:${item.id}`;
        const state = states[key];
        if (state) {
          result.set(item.id, state);
        }
      }

      return result;
    } catch (error) {
      // Log full error details for debugging 502/connection Refused
      options?.logger?.error?.(
        { err: error, userId, itemCount: items.length },
        "Failed to fetch engagement states (loadEngagementStates)"
      );
      // Return empty map to avoid crashing the whole home feed, but now we have logs
      return new Map();
    }
  }
}
