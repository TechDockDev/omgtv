import {
  Category,
  Episode,
  MediaAsset,
  MediaAssetStatus,
  MediaAssetVariant,
  Prisma,
  PublicationStatus,
  Season,
  Series,
  Visibility,
} from "@prisma/client";
import {
  CatalogRepository,
  PaginatedResult,
  CarouselEntryWithContent,
  EpisodeWithRelations,
} from "../repositories/catalog-repository";
import { CatalogEventsPublisher, type CatalogEvent } from "./catalog-events";

export type CatalogErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "FAILED_PRECONDITION"
  | "INVALID_STATE";

export class CatalogServiceError extends Error {
  constructor(
    public readonly code: CatalogErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CatalogServiceError";
  }
}

function isKnownPrismaError(error: unknown, code: string) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

export type CatalogServiceOptions = {
  defaultOwnerId: string;
  repository?: CatalogRepository;
  eventsPublisher?: CatalogEventsPublisher;
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class CatalogService {
  private readonly repo: CatalogRepository;
  private readonly defaultOwnerId: string;
  private readonly events?: CatalogEventsPublisher;

  constructor(options: CatalogServiceOptions) {
    this.repo = options.repository ?? new CatalogRepository();
    this.defaultOwnerId = options.defaultOwnerId;
    this.events = options.eventsPublisher;
  }

  private async ensureTagsExist(tags?: string[]) {
    if (!tags || tags.length === 0) {
      return;
    }
    const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }
    const found = await this.repo.findTagsByNames(normalized);
    const missing = normalized.filter(
      (tag) => !found.some((entry) => entry.name === tag)
    );
    if (missing.length > 0) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Tags not found: ${missing.join(", ")}`
      );
    }
  }

  private async emitCatalogEvent(event: {
    entity: CatalogEvent["entity"];
    entityId: string;
    operation: CatalogEvent["operation"];
    payload?: Record<string, unknown>;
  }) {
    if (!this.events) {
      return;
    }
    await this.events.publish({
      type: "catalog.updated",
      entity: event.entity,
      entityId: event.entityId,
      operation: event.operation,
      timestamp: new Date().toISOString(),
      payload: event.payload,
    });
  }

  private ensureCarouselEpisodeSelectable(episode: EpisodeWithRelations) {
    if (episode.status !== PublicationStatus.PUBLISHED) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Episode ${episode.id} must be published before featuring`
      );
    }
    if (
      episode.visibility !== Visibility.PUBLIC &&
      episode.visibility !== Visibility.UNLISTED
    ) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Episode ${episode.id} must be publicly visible before featuring`
      );
    }
    if (
      !episode.mediaAsset ||
      episode.mediaAsset.status !== MediaAssetStatus.READY
    ) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Episode ${episode.id} does not have a ready streaming asset`
      );
    }
  }

  private ensureCarouselSeriesSelectable(series: Series) {
    if (series.status !== PublicationStatus.PUBLISHED) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Series ${series.id} must be published before featuring`
      );
    }
    if (series.visibility !== Visibility.PUBLIC) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Series ${series.id} must be public before featuring`
      );
    }
  }

  async createCategory(
    adminId: string,
    input: {
      slug: string;
      name: string;
      description?: string | null;
      displayOrder?: number | null;
    }
  ): Promise<Category> {
    try {
      const category = await this.repo.createCategory({
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        displayOrder: input.displayOrder ?? null,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "category",
        entityId: category.id,
        operation: "create",
        payload: { slug: category.slug },
      });
      return category;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Category with this slug already exists"
        );
      }
      throw error;
    }
  }

  async getCategoryById(id: string): Promise<Category> {
    const existing = await this.repo.findCategoryById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Category not found");
    }
    return existing;
  }

  async listCategories(params: {
    limit?: number;
    cursor?: string | null;
  }): Promise<PaginatedResult<Category>> {
    return this.repo.listCategories(params);
  }

  async createTag(
    adminId: string,
    input: { name: string; description?: string | null; slug?: string }
  ) {
    const slug = (input.slug ?? slugify(input.name)) || slugify(input.name);
    try {
      const tag = await this.repo.createTag({
        slug,
        name: input.name.trim(),
        description: input.description ?? null,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "tag",
        entityId: tag.id,
        operation: "create",
        payload: { slug: tag.slug },
      });
      return tag;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Tag with this name or slug already exists"
        );
      }
      throw error;
    }
  }

  async listTags(params: { limit?: number; cursor?: string | null }) {
    return this.repo.listTags(params);
  }

  async updateCategory(
    adminId: string,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      displayOrder?: number | null;
      slug?: string;
    }
  ): Promise<Category> {
    const existing = await this.repo.findCategoryById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Category not found");
    }
    try {
      const category = await this.repo.updateCategory(id, {
        name: input.name,
        description: input.description,
        displayOrder: input.displayOrder,
        slug: input.slug,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "category",
        entityId: category.id,
        operation: "update",
        payload: {
          slug: category.slug,
        },
      });
      return category;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Category with this slug already exists"
        );
      }
      throw error;
    }
  }

  async deleteCategory(adminId: string, id: string): Promise<void> {
    const existing = await this.repo.findCategoryById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Category not found");
    }
    await this.repo.softDeleteCategory(id, adminId);
    await this.emitCatalogEvent({
      entity: "category",
      entityId: id,
      operation: "delete",
      payload: { slug: existing.slug },
    });
  }

  async deleteSeries(adminId: string, id: string): Promise<void> {
    const existing = await this.repo.findSeriesById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }
    await this.repo.softDeleteSeries(id, adminId);
    await this.emitCatalogEvent({
      entity: "series",
      entityId: id,
      operation: "delete",
      payload: { slug: existing.slug },
    });
  }

  async createSeries(
    adminId: string,
    input: {
      slug: string;
      title: string;
      synopsis?: string | null;
      heroImageUrl?: string | null;
      bannerImageUrl?: string | null;
      tags?: string[];
      status?: PublicationStatus;
      visibility?: Visibility;
      releaseDate?: Date | null;
      ownerId?: string;
      categoryId?: string | null;
    }
  ): Promise<Series> {
    const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
    await this.ensureTagsExist(tags);

    if (input.categoryId) {
      const category = await this.repo.findCategoryById(input.categoryId);
      if (!category) {
        throw new CatalogServiceError(
          "FAILED_PRECONDITION",
          "Category does not exist or is archived"
        );
      }
    }
    try {
      const series = await this.repo.createSeries({
        slug: input.slug,
        title: input.title,
        synopsis: input.synopsis ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        bannerImageUrl: input.bannerImageUrl ?? null,
        tags,
        status: input.status,
        visibility: input.visibility,
        releaseDate: input.releaseDate ?? null,
        ownerId: input.ownerId ?? this.defaultOwnerId,
        categoryId: input.categoryId ?? null,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "series",
        entityId: series.id,
        operation: "create",
        payload: {
          slug: series.slug,
          categoryId: series.categoryId,
        },
      });
      return series;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Series with this slug already exists"
        );
      }
      throw error;
    }
  }

  async updateSeries(
    adminId: string,
    id: string,
    input: {
      title?: string;
      synopsis?: string | null;
      heroImageUrl?: string | null;
      bannerImageUrl?: string | null;
      tags?: string[];
      status?: PublicationStatus;
      visibility?: Visibility;
      releaseDate?: Date | null;
      categoryId?: string | null;
      slug?: string;
      ownerId?: string;
    }
  ): Promise<Series> {
    const series = await this.repo.findSeriesById(id);
    if (!series) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }
    if (input.categoryId) {
      const category = await this.repo.findCategoryById(input.categoryId);
      if (!category) {
        throw new CatalogServiceError(
          "FAILED_PRECONDITION",
          "Category does not exist or is archived"
        );
      }
    }

    const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean);
    await this.ensureTagsExist(tags);

    try {
      const series = await this.repo.updateSeries(id, {
        title: input.title,
        synopsis: input.synopsis,
        heroImageUrl: input.heroImageUrl,
        bannerImageUrl: input.bannerImageUrl,
        tags,
        status: input.status,
        visibility: input.visibility,
        releaseDate: input.releaseDate,
        categoryId: input.categoryId,
        slug: input.slug,
        ownerId: input.ownerId,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "series",
        entityId: series.id,
        operation: "update",
        payload: {
          slug: series.slug,
          status: series.status,
          visibility: series.visibility,
        },
      });
      return series;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Series with this slug already exists"
        );
      }
      throw error;
    }
  }

  async createSeason(
    adminId: string,
    input: {
      seriesId: string;
      sequenceNumber: number;
      title: string;
      synopsis?: string | null;
      releaseDate?: Date | null;
    }
  ): Promise<Season> {
    const series = await this.repo.findSeriesById(input.seriesId);
    if (!series) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }
    try {
      const season = await this.repo.createSeason({
        seriesId: input.seriesId,
        sequenceNumber: input.sequenceNumber,
        title: input.title,
        synopsis: input.synopsis ?? null,
        releaseDate: input.releaseDate ?? null,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "season",
        entityId: season.id,
        operation: "create",
        payload: {
          seriesId: season.seriesId,
          sequenceNumber: season.sequenceNumber,
        },
      });
      return season;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Season number already exists for this series"
        );
      }
      throw error;
    }
  }

  async createEpisode(
    adminId: string,
    input: {
      seriesId: string;
      seasonId?: string | null;
      slug: string;
      title: string;
      synopsis?: string | null;
      durationSeconds: number;
      status?: PublicationStatus;
      visibility?: Visibility;
      publishedAt?: Date | null;
      availabilityStart?: Date | null;
      availabilityEnd?: Date | null;
      heroImageUrl?: string | null;
      defaultThumbnailUrl?: string | null;
      captions?: unknown;
      tags?: string[];
    }
  ): Promise<Episode> {
    const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
    await this.ensureTagsExist(tags);

    const series = await this.repo.findSeriesById(input.seriesId);
    if (!series) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }
    if (input.seasonId) {
      const season = await this.repo.findSeasonById(input.seasonId);
      if (!season || season.seriesId !== series.id) {
        throw new CatalogServiceError(
          "FAILED_PRECONDITION",
          "Season does not exist for this series"
        );
      }
    }

    try {
      const episode = await this.repo.createEpisode({
        slug: input.slug,
        seriesId: input.seriesId,
        seasonId: input.seasonId ?? null,
        title: input.title,
        synopsis: input.synopsis ?? null,
        durationSeconds: input.durationSeconds,
        status: input.status,
        visibility: input.visibility,
        publishedAt: input.publishedAt ?? null,
        availabilityStart: input.availabilityStart ?? null,
        availabilityEnd: input.availabilityEnd ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        defaultThumbnailUrl: input.defaultThumbnailUrl ?? null,
        captions: input.captions as Prisma.JsonValue | null,
        tags,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "episode",
        entityId: episode.id,
        operation: "create",
        payload: {
          slug: episode.slug,
          seriesId: episode.seriesId,
          seasonId: episode.seasonId,
          status: episode.status,
        },
      });
      return episode;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Episode with this slug already exists"
        );
      }
      throw error;
    }
  }

  async updateEpisodeStatus(
    adminId: string,
    episodeId: string,
    targetStatus: PublicationStatus
  ): Promise<Episode> {
    const episode = await this.repo.findEpisodeById(episodeId);
    if (!episode) {
      throw new CatalogServiceError("NOT_FOUND", "Episode not found");
    }

    if (!this.isTransitionAllowed(episode.status, targetStatus)) {
      throw new CatalogServiceError(
        "INVALID_STATE",
        `Cannot transition episode from ${episode.status} to ${targetStatus}`
      );
    }

    const publishedAt =
      targetStatus === PublicationStatus.PUBLISHED
        ? new Date()
        : (episode.publishedAt ?? null);

    const updated = await this.repo.updateEpisodeStatus(
      episodeId,
      targetStatus,
      adminId,
      publishedAt
    );
    await this.emitCatalogEvent({
      entity: "episode",
      entityId: updated.id,
      operation: "update",
      payload: {
        status: updated.status,
        publishedAt: updated.publishedAt,
      },
    });
    return updated;
  }

  async updateEpisodeTags(
    adminId: string,
    episodeId: string,
    tags: string[]
  ): Promise<{ id: string; tags: string[] }> {
    const episode = await this.repo.findEpisodeById(episodeId);
    if (!episode) {
      throw new CatalogServiceError("NOT_FOUND", "Episode not found");
    }

    const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
    await this.ensureTagsExist(normalized);

    return this.repo.updateEpisodeTags(episodeId, normalized, adminId);
  }

  async deleteEpisode(adminId: string, id: string): Promise<void> {
    const existing = await this.repo.findEpisodeById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Episode not found");
    }
    await this.repo.softDeleteEpisode(id, adminId);
    await this.emitCatalogEvent({
      entity: "episode",
      entityId: id,
      operation: "delete",
      payload: {
        seriesId: existing.seriesId,
        seasonId: existing.seasonId,
      },
    });
  }

  async updateReelTags(
    adminId: string,
    reelId: string,
    tags: string[]
  ): Promise<{ id: string; tags: string[] }> {
    const reel = await this.repo.findReelById(reelId);
    if (!reel) {
      throw new CatalogServiceError("NOT_FOUND", "Reel not found");
    }

    const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
    await this.ensureTagsExist(normalized);

    return this.repo.updateReelTags(reelId, normalized, adminId);
  }

  async registerEpisodeAsset(
    adminId: string,
    input: {
      episodeId: string;
      status: MediaAssetStatus;
      sourceUploadId?: string | null;
      streamingAssetId?: string | null;
      manifestUrl?: string | null;
      defaultThumbnailUrl?: string | null;
      variants: Array<{
        label: string;
        width?: number | null;
        height?: number | null;
        bitrateKbps?: number | null;
        codec?: string | null;
        frameRate?: number | null;
      }>;
    }
  ): Promise<MediaAsset & { variants: MediaAssetVariant[] }> {
    const episode = await this.repo.findEpisodeById(input.episodeId);
    if (!episode) {
      throw new CatalogServiceError("NOT_FOUND", "Episode not found");
    }

    if (input.variants.length === 0) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "At least one media variant must be provided"
      );
    }

    const asset = await this.repo.upsertEpisodeAsset({
      episodeId: input.episodeId,
      adminId,
      status: input.status,
      sourceUploadId: input.sourceUploadId ?? null,
      streamingAssetId: input.streamingAssetId ?? null,
      manifestUrl: input.manifestUrl ?? null,
      defaultThumbnailUrl: input.defaultThumbnailUrl ?? null,
      variants: input.variants,
    });
    await this.emitCatalogEvent({
      entity: "mediaAsset",
      entityId: asset.id,
      operation: "update",
      payload: {
        episodeId: input.episodeId,
        status: asset.status,
      },
    });
    return asset;
  }

  async listModerationQueue(params: {
    status?: PublicationStatus | null;
    limit?: number;
    cursor?: string | null;
  }): Promise<
    PaginatedResult<
      Episode & {
        mediaAsset: Pick<MediaAsset, "status" | "manifestUrl"> | null;
      }
    >
  > {
    return this.repo.listModerationQueue(params);
  }

  async setCarouselEntries(
    adminId: string,
    input: {
      items: Array<{ seriesId?: string | null; episodeId?: string | null }>;
    }
  ): Promise<CarouselEntryWithContent[]> {
    if (!input.items || input.items.length === 0) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "At least one carousel entry is required"
      );
    }

    const normalized = input.items.map((item, index) => ({
      index,
      seriesId: item.seriesId ?? null,
      episodeId: item.episodeId ?? null,
    }));

    normalized.forEach((entry, index) => {
      const hasSeries = Boolean(entry.seriesId);
      const hasEpisode = Boolean(entry.episodeId);
      if (hasSeries === hasEpisode) {
        throw new CatalogServiceError(
          "FAILED_PRECONDITION",
          `Carousel entry ${index + 1} must reference exactly one series or one episode`
        );
      }
    });

    const episodeIds = Array.from(
      new Set(
        normalized
          .map((entry) => entry.episodeId)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0
          )
      )
    );
    const seriesIds = Array.from(
      new Set(
        normalized
          .map((entry) => entry.seriesId)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0
          )
      )
    );

    const [episodes, series] = await Promise.all([
      this.repo.findEpisodesWithRelationsByIds(episodeIds),
      this.repo.findSeriesByIds(seriesIds),
    ]);

    const episodesById = new Map(
      episodes.map((episode) => [episode.id, episode])
    );
    const seriesById = new Map(series.map((record) => [record.id, record]));

    normalized.forEach((entry) => {
      if (entry.episodeId) {
        const episode = episodesById.get(entry.episodeId);
        if (!episode) {
          throw new CatalogServiceError(
            "FAILED_PRECONDITION",
            `Episode ${entry.episodeId} is unavailable`
          );
        }
        this.ensureCarouselEpisodeSelectable(episode);
      }
      if (entry.seriesId) {
        const record = seriesById.get(entry.seriesId);
        if (!record) {
          throw new CatalogServiceError(
            "FAILED_PRECONDITION",
            `Series ${entry.seriesId} is unavailable`
          );
        }
        this.ensureCarouselSeriesSelectable(record);
      }
    });

    await this.repo.replaceCarouselEntries({
      adminId,
      items: normalized.map((entry, index) => ({
        position: index + 1,
        episodeId: entry.episodeId,
        seriesId: entry.seriesId,
      })),
    });

    return this.repo.listCarouselEntries();
  }

  private isTransitionAllowed(
    current: PublicationStatus,
    target: PublicationStatus
  ) {
    if (current === target) {
      return false;
    }
    const allowedMap: Record<PublicationStatus, PublicationStatus[]> = {
      [PublicationStatus.DRAFT]: [
        PublicationStatus.REVIEW,
        PublicationStatus.ARCHIVED,
      ],
      [PublicationStatus.REVIEW]: [
        PublicationStatus.PUBLISHED,
        PublicationStatus.ARCHIVED,
      ],
      [PublicationStatus.PUBLISHED]: [PublicationStatus.ARCHIVED],
      [PublicationStatus.ARCHIVED]: [],
    };
    return allowedMap[current].includes(target);
  }
}
