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
  ) {}

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

    const feed = await this.deps.viewerCatalog.getFeed({
      limit: parsed.limit ?? this.deps.config.homeFeedLimit,
      cursor: parsed.cursor,
    });

    const filteredItems = this.filterByTag(feed.items, parsed.tag);
    const entitlements = await this.resolveEntitlements(options);
    const progressMap = await this.loadProgressMap(filteredItems, {
      limit: this.deps.config.continueWatchLimit * 4,
      options,
    });
    const carouselItems = await this.buildCarouselItems(filteredItems);
    const prioritizedItems = [
      ...filteredItems.filter((item) => progressMap.has(item.id)),
      ...filteredItems.filter((item) => !progressMap.has(item.id)),
    ];
    const continueWatchSource = prioritizedItems.slice(
      0,
      this.deps.config.continueWatchLimit
    );
    const continueWatch = continueWatchSource.map((item) =>
      this.toContinueWatchItem(
        item,
        entitlements.episode,
        progressMap.get(item.id)
      )
    );

    const sectionItems = filteredItems
      .slice(0, this.deps.config.sectionItemLimit)
      .map((item) => this.toSectionEntry(item, progressMap.get(item.id)));

    const sections = this.buildSections(
      sectionItems,
      continueWatch,
      parsed.tag
    );

    const currentPage = parsed.page ?? 1;
    const hasNextPage = Boolean(feed.nextCursor);

    const data: MobileHomeData = {
      carousel: carouselItems,
      "continue watch": continueWatch,
      sections,
      pagination: {
        currentPage,
        totalPages: hasNextPage ? currentPage + 1 : currentPage,
        hasNextPage,
        nextCursor: feed.nextCursor ?? null,
      },
    };

    return {
      data: mobileHomeDataSchema.parse(data),
      fromCache: feed.fromCache,
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
    const progressMap = await this.loadProgressMap(
      [
        ...detail.seasons.flatMap((season) => season.episodes),
        ...detail.standaloneEpisodes,
      ],
      {
        options,
        limit: 200,
      }
    );

    const data = this.buildSeriesPayload(detail, {
      entitlements,
      progressMap,
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
    const items = result.items.map((reel) =>
      this.toReelItem(reel, entitlements.reel)
    );

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
    feedItems: ViewerFeedItem[]
  ): Promise<CarouselEntryView[]> {
    const limit = this.deps.config.carouselLimit;
    const entries = await this.deps.repository.listCarouselEntries();
    if (entries.length === 0) {
      return feedItems
        .slice(0, limit)
        .map((item, index) => this.toCarouselItem(item, index + 1));
    }

    const curated = this.formatCuratedCarouselEntries(entries);
    if (curated.length === 0) {
      return feedItems
        .slice(0, limit)
        .map((item, index) => this.toCarouselItem(item, index + 1));
    }

    const trimmed = curated.slice(0, limit);
    if (trimmed.length === limit) {
      return trimmed;
    }

    const usedIds = new Set(trimmed.map((entry) => entry.id));
    const remaining = limit - trimmed.length;
    const highestPriority = trimmed.reduce(
      (max, entry) => Math.max(max, entry.priority),
      0
    );
    const fallback = feedItems
      .filter((item) => !usedIds.has(item.id))
      .slice(0, remaining)
      .map((item, index) =>
        this.toCarouselItem(item, highestPriority + index + 1)
      );

    return [...trimmed, ...fallback];
  }

  private formatCuratedCarouselEntries(
    entries: CarouselEntryWithContent[]
  ): CarouselEntryView[] {
    const items: CarouselEntryView[] = [];
    for (const entry of entries) {
      if (entry.episode) {
        const feedItem = buildFeedItem(
          entry.episode,
          { reason: "recent" },
          null
        );
        items.push(this.toCarouselItem(feedItem, entry.position));
        continue;
      }
      if (entry.series) {
        items.push(this.toSeriesCarouselItem(entry.series, entry.position));
      }
    }
    return items.sort((a, b) => a.priority - b.priority);
  }

  private toSeriesCarouselItem(
    series: NonNullable<CarouselEntryWithContent["series"]>,
    priority: number
  ): CarouselEntryView {
    return {
      id: series.id,
      priority,
      type: "series",
      title: series.title,
      subtitle: series.category?.name ?? null,
      thumbnailUrl: series.heroImageUrl ?? series.bannerImageUrl ?? null,
      videoUrl: null,
      rating: null,
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
      rating: item.ratings.average,
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

  private toSectionEntry(item: ViewerFeedItem, progress?: ContinueWatchEntry) {
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
      rating: item.ratings.average,
      lastWatchedAt: progress?.last_watched_at ?? null,
      series_id: item.series.id,
    };
  }

  private buildSections(
    featured: ReturnType<MobileAppService["toSectionEntry"]>[],
    continueWatch: ReturnType<MobileAppService["toContinueWatchItem"]>[],
    tag?: string
  ) {
    const sections = [] as MobileHomeData["sections"];

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

    if (featured.length > 0) {
      sections.push({
        id: `section_${(tag ?? "featured").toLowerCase()}`,
        type: tag ? "category" : "featured",
        title: tag ? tag.replace(/\b\w/g, (c) => c.toUpperCase()) : "Featured",
        priority: sections.length + 1,
        items: featured,
      });
    }

    return sections;
  }

  private buildSeriesPayload(
    detail: SeriesDetailResponse,
    options: {
      entitlements: EntitlementLookup;
      progressMap: Map<string, ContinueWatchEntry>;
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
      reviews: {
        summary: {
          average_rating: averageRating,
          total_reviews: ratings.length,
        },
        user_reviews: [],
      },
    };
  }

  private flattenEpisodes(
    detail: SeriesDetailResponse,
    options: {
      entitlements: EntitlementLookup;
      progressMap: Map<string, ContinueWatchEntry>;
    }
  ) {
    const entries: MobileSeriesData["episodes"] = [];

    detail.seasons.forEach((season) => {
      season.episodes.forEach((episode, idx) => {
        entries.push(
          this.toSeriesEpisode(
            episode,
            season.sequenceNumber,
            idx + 1,
            options.entitlements.episode,
            options.progressMap.get(episode.id)
          )
        );
      });
    });

    detail.standaloneEpisodes.forEach((episode, idx) => {
      entries.push(
        this.toSeriesEpisode(
          episode,
          null,
          idx + 1,
          options.entitlements.episode,
          options.progressMap.get(episode.id)
        )
      );
    });

    return entries;
  }

  private toSeriesEpisode(
    episode: ViewerFeedItem,
    seasonNumber: number | null,
    episodeIndex: number,
    entitlement: EntitlementSnapshot,
    progress?: ContinueWatchEntry
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
      rating: episode.ratings.average,
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
    entitlement: EntitlementSnapshot
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
      rating: null,
      thumbnail: reel.mediaAsset?.defaultThumbnailUrl ?? null,
      streaming,
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
}
