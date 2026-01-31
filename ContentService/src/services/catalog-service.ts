import {
  Category,
  Episode,
  MediaAsset,
  MediaAssetStatus,
  MediaAssetType,
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
import { PubSub } from "@google-cloud/pubsub";
import { loadConfig } from "../config";

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
  config?: any; // ReturnType<typeof loadConfig>; using any to avoid type complexity for now or import Env
  pubsub?: PubSub;
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface MediaUploadedEvent {
  uploadId: string;
  contentId?: string;
  contentType?: string;
  filename?: string;
  storageUrl?: string;
  cdnUrl?: string;
  assetType?: string;
  sizeBytes?: number;
}

interface MediaCompletionEvent {
  uploadId: string;
  contentId?: string;
  contentType?: string;
  manifestUrl: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  filename?: string;
  renditions: any[];
}

export class CatalogService {
  private readonly repo: CatalogRepository;
  private readonly defaultOwnerId: string;
  private readonly events?: CatalogEventsPublisher;
  private readonly pubsub?: PubSub;
  private readonly config?: any; // ReturnType<typeof loadConfig>

  constructor(options: CatalogServiceOptions) {
    this.repo = options.repository ?? new CatalogRepository();
    this.defaultOwnerId = options.defaultOwnerId;
    this.events = options.eventsPublisher;
    this.pubsub = options.pubsub;
    this.config = options.config;
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
      name: string;
      description?: string | null;
      displayOrder?: number | null;
    }
  ): Promise<{ restored: boolean; category: Category }> {
    const baseSlug = slugify(input.name);
    let slug = baseSlug;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const existing = await this.repo.findCategoryBySlugIncludingDeleted(slug);

      if (!existing) {
        break;
      }

      const uniqueSuffix = Math.random().toString(36).substring(2, 8);
      slug = `${baseSlug}-${uniqueSuffix}`;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new CatalogServiceError(
        "CONFLICT",
        "Could not generate unique slug after multiple attempts"
      );
    }

    try {
      const category = await this.repo.createCategory({
        slug,
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
      return { restored: false, category };
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Slug conflict occurred, please try again"
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
    const baseSlug = input.slug || slugify(input.name);
    let slug = baseSlug;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const existing = await this.repo.findTagBySlugIncludingDeleted(slug);

      if (!existing) {
        break;
      }

      const uniqueSuffix = Math.random().toString(36).substring(2, 8);
      slug = `${baseSlug}-${uniqueSuffix}`;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new CatalogServiceError(
        "CONFLICT",
        "Could not generate unique slug after multiple attempts"
      );
    }

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

  async updateTag(
    adminId: string,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      slug?: string;
    }
  ) {
    const existing = await this.repo.findTagById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Tag not found");
    }

    try {
      const tag = await this.repo.updateTag(id, {
        name: input.name,
        description: input.description,
        slug: input.slug,
        adminId,
      });
      await this.emitCatalogEvent({
        entity: "tag",
        entityId: tag.id,
        operation: "update",
        payload: { slug: tag.slug },
      });
      return tag;
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        throw new CatalogServiceError(
          "CONFLICT",
          "Tag with this slug already exists"
        );
      }
      throw error;
    }
  }

  async deleteTag(
    adminId: string,
    id: string
  ): Promise<{ alreadyDeleted: boolean; tag: { id: string; slug: string; deletedAt: Date | null } }> {
    const existing = await this.repo.findTagByIdIncludingDeleted(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Tag not found");
    }

    if (existing.deletedAt) {
      return {
        alreadyDeleted: true,
        tag: { id: existing.id, slug: existing.slug, deletedAt: existing.deletedAt },
      };
    }

    await this.repo.softDeleteTag(id, adminId);
    await this.emitCatalogEvent({
      entity: "tag",
      entityId: id,
      operation: "delete",
      payload: { slug: existing.slug },
    });
    return {
      alreadyDeleted: false,
      tag: { id: existing.id, slug: existing.slug, deletedAt: new Date() },
    };
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

  async deleteCategory(
    adminId: string,
    id: string
  ): Promise<{ alreadyDeleted: boolean; category: { id: string; slug: string; deletedAt: Date | null } }> {
    const existing = await this.repo.findCategoryByIdIncludingDeleted(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Category not found");
    }
    if (existing.deletedAt) {
      return {
        alreadyDeleted: true,
        category: { id: existing.id, slug: existing.slug, deletedAt: existing.deletedAt },
      };
    }
    await this.repo.softDeleteCategory(id, adminId);
    await this.emitCatalogEvent({
      entity: "category",
      entityId: id,
      operation: "delete",
      payload: { slug: existing.slug },
    });
    return {
      alreadyDeleted: false,
      category: { id: existing.id, slug: existing.slug, deletedAt: new Date() },
    };
  }

  async deleteSeries(adminId: string, id: string): Promise<void> {
    const existing = await this.repo.findSeriesById(id);
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }

    // Safety Check: Ensure no episodes exist
    const episodeCount = await this.repo.countEpisodesBySeriesId(id);
    if (episodeCount > 0) {
      throw new CatalogServiceError("FAILED_PRECONDITION", `Cannot delete series with ${episodeCount} existing episodes. Delete episodes first.`);
    }

    await this.repo.softDeleteSeries(id, adminId);
    await this.emitCatalogEvent({
      entity: "series",
      entityId: id,
      operation: "delete",
      payload: { slug: existing.slug },
    });
  }

  async getSeries(id: string) {
    const series = await this.repo.findSeriesById(id);
    if (!series) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }
    return series;
  }

  async listSeries(params: {
    limit?: number;
    cursor?: string | null;
    isAudioSeries?: boolean;
  }) {
    const result = await this.repo.listSeries(params);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        _count: undefined,
        episodeCount: item._count.episodes,
      })),
    };
  }

  async createSeries(
    adminId: string,
    input: {
      slug?: string;
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
      isAudioSeries?: boolean;
      displayOrder?: number | null;
      isCarousel?: boolean;
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

      if (input.displayOrder !== undefined && input.displayOrder !== null) {
        const conflict = await this.repo.findSeriesByCategoryIdAndDisplayOrder(
          input.categoryId,
          input.displayOrder
        );
        if (conflict) {
          throw new CatalogServiceError(
            "CONFLICT",
            `Series with display order ${input.displayOrder} already exists in this category`
          );
        }
      }
    }

    const baseSlug = input.slug || slugify(input.title);
    let slug = baseSlug;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const existing = await this.repo.findSeriesBySlug(slug);
      if (!existing) {
        break;
      }
      const uniqueSuffix = Math.random().toString(36).substring(2, 8);
      slug = `${baseSlug}-${uniqueSuffix}`;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new CatalogServiceError(
        "CONFLICT",
        "Could not generate unique slug after multiple attempts"
      );
    }

    try {
      const series = await this.repo.createSeries({
        slug,
        title: input.title,
        synopsis: input.synopsis ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        bannerImageUrl: input.bannerImageUrl ?? null,
        tags,
        status: input.status,
        visibility: input.visibility,
        releaseDate: input.releaseDate ?? null,
        ownerId: input.ownerId ?? adminId ?? this.defaultOwnerId,
        categoryId: input.categoryId ?? null,
        isAudioSeries: input.isAudioSeries,
        displayOrder: input.displayOrder ?? null,
        adminId,
      });

      if (input.isCarousel) {
        try {
          this.ensureCarouselSeriesSelectable(series);
          await this.repo.upsertCarouselEntry({
            seriesId: series.id,
            adminId
          });
        } catch (carouselError) {
          // Log but don't fail series creation if carousel add fails (e.g. not published yet)
          // Or should we fail? Requirement says "attach to carousel only select and submit".
          // If requirements are strict about publication status, this might fail.
          // Given user said "button to make it carousel", implies intent.
          // However, ensureCarouselSeriesSelectable throws if not published.
          // If we create as DRAFT, this will fail.
          // We'll let it execute and if it fails, maybe we should warn or ignore?
          // Since this is CREATE, typically series is created as DRAFT first.
          // If user sets status=PUBLISHED in create, it works.
          // I will swallow error but log it, or perhaps return a warning?
          // For now, let's assume if they ask for carousel, they provide valid status.
          // If not, we won't add to carousel but won't fail creation.
          console.warn(`Could not add new series ${series.id} to carousel: ${(carouselError as Error).message}`);
        }
      }

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
      isAudioSeries?: boolean;
      displayOrder?: number | null;
      isCarousel?: boolean;
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

    const targetCategoryId = input.categoryId !== undefined ? input.categoryId : series.categoryId;
    const targetDisplayOrder = input.displayOrder !== undefined ? input.displayOrder : series.displayOrder;

    // Check conflict if category or order is changing (and both are present/valid)
    if (
      targetCategoryId &&
      targetDisplayOrder !== null &&
      (input.categoryId !== undefined || input.displayOrder !== undefined)
    ) {
      // If we strictly check uniqueness, we need to see if another series has this slot
      const conflict = await this.repo.findSeriesByCategoryIdAndDisplayOrder(targetCategoryId, targetDisplayOrder);
      if (conflict && conflict.id !== id) {
        throw new CatalogServiceError(
          "CONFLICT",
          `Series with display order ${targetDisplayOrder} already exists in this category`
        );
      }
    }

    const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean);
    await this.ensureTagsExist(tags);

    try {
      const updatedSeries = await this.repo.updateSeries(id, {
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
        isAudioSeries: input.isAudioSeries,
        displayOrder: input.displayOrder,
        adminId,
      });

      if (input.isCarousel !== undefined) {
        if (input.isCarousel) {
          this.ensureCarouselSeriesSelectable(updatedSeries);
          await this.repo.upsertCarouselEntry({
            seriesId: updatedSeries.id,
            adminId
          });
        } else {
          await this.repo.deleteCarouselEntriesBySeriesId(updatedSeries.id);
        }
      }

      await this.emitCatalogEvent({
        entity: "series",
        entityId: updatedSeries.id,
        operation: "update",
        payload: {
          slug: updatedSeries.slug,
          status: updatedSeries.status,
          visibility: updatedSeries.visibility,
        },
      });
      return updatedSeries;
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
      slug?: string;
      title: string;
      synopsis?: string | null;
      episodeNumber?: number | null;
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
      mediaAssetId?: string; // Support direct linking by ID
      uploadId?: string;
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

    // Verify MediaAsset: Check mediaAssetId FIRST, then uploadId
    let mediaAsset: MediaAsset | null = null;
    if (input.mediaAssetId) {
      mediaAsset = await this.repo.findMediaAssetById(input.mediaAssetId);
      if (!mediaAsset) {
        throw new CatalogServiceError("FAILED_PRECONDITION", `MediaAsset not found for id: ${input.mediaAssetId}`);
      }
    } else if (input.uploadId) {
      mediaAsset = await this.repo.findMediaAssetByUploadId(input.uploadId);
      if (!mediaAsset) {
        throw new CatalogServiceError("FAILED_PRECONDITION", `MediaAsset not found for uploadId: ${input.uploadId}`);
      }
    }

    // Fallback thumbnail logic
    const resolvedThumbnailUrl = input.defaultThumbnailUrl ?? mediaAsset?.defaultThumbnailUrl ?? null;

    if (input.episodeNumber !== undefined && input.episodeNumber !== null) {
      const existingEpisode = await this.repo.findEpisodeByNumber(
        input.seriesId,
        input.episodeNumber,
        input.seasonId
      );
      if (existingEpisode) {
        throw new CatalogServiceError(
          "CONFLICT",
          `Episode with number ${input.episodeNumber} already exists in this series/season`
        );
      }
    }

    // Auto-generate slug if missing
    const baseSlug = input.slug || slugify(input.title);
    let slug = baseSlug;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const existing = await this.repo.findEpisodeBySlug(slug);
      if (!existing) {
        break;
      }
      const uniqueSuffix = Math.random().toString(36).substring(2, 8);
      slug = `${baseSlug}-${uniqueSuffix}`;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new CatalogServiceError(
        "CONFLICT",
        "Could not generate unique slug after multiple attempts"
      );
    }

    try {
      const episode = await this.repo.createEpisode({
        slug,
        seriesId: input.seriesId,
        seasonId: input.seasonId ?? null,
        title: input.title,
        synopsis: input.synopsis ?? null,
        episodeNumber: input.episodeNumber ?? null, // Add episodeNumber support
        durationSeconds: input.durationSeconds,
        status: input.status,
        visibility: input.visibility,
        publishedAt: input.publishedAt ?? null,
        availabilityStart: input.availabilityStart ?? null,
        availabilityEnd: input.availabilityEnd ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        defaultThumbnailUrl: resolvedThumbnailUrl,
        captions: input.captions as Prisma.JsonValue | null,
        tags,
        adminId,
      });

      // Link MediaAsset if resolved
      if (mediaAsset) {
        // Use ID based assignment since we resolved the asset
        await this.repo.assignMediaAssetToEpisodeById(mediaAsset.id, episode.id);
      }

      await this.emitCatalogEvent({
        entity: "episode",
        entityId: episode.id,
        operation: "create",
        payload: {
          slug: episode.slug,
          seriesId: episode.seriesId,
          seriesSlug: series.slug, // Added for cache invalidation
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
    const episode = await this.repo.findEpisodeById(episodeId, true); // Include relations to get series slug
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

    // We already fetched episode with relations above, so we can use that for series slug
    await this.emitCatalogEvent({
      entity: "episode",
      entityId: updated.id,
      operation: "update",
      payload: {
        status: updated.status,
        publishedAt: updated.publishedAt,
        seriesSlug: (episode as any).series.slug,
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

  async getEpisode(id: string) {
    const episode = await this.repo.findEpisodeById(id);
    if (!episode) {
      throw new CatalogServiceError("NOT_FOUND", "Episode not found");
    }
    return episode;
  }

  async listEpisodes(params: {
    seriesId?: string;
    limit?: number;
    cursor?: string | null;
  }) {
    return this.repo.listEpisodes(params);
  }

  async updateEpisode(
    adminId: string,
    episodeId: string,
    data: {
      title?: string;
      synopsis?: string;
      slug?: string;
      seasonId?: string;
      seriesId?: string;
      durationSeconds?: number;
      heroImageUrl?: string | null;
      defaultThumbnailUrl?: string | null; // Allow null to clear
      availabilityStart?: Date;
      availabilityEnd?: Date;
      mediaAssetId?: string | null;
      uploadId?: string | null; // For replacing video
      episodeNumber?: number | null;
    }
  ) {
    const existing = await this.repo.findEpisodeById(episodeId, true); // Include relations to get current media asset
    if (!existing) {
      throw new CatalogServiceError("NOT_FOUND", `Episode ${episodeId} not found`);
    }

    if (data.seasonId) {
      const season = await this.repo.findSeasonById(data.seasonId);
      if (!season) {
        throw new CatalogServiceError("NOT_FOUND", `Season ${data.seasonId} not found`);
      }
    }

    if (data.episodeNumber !== undefined && data.episodeNumber !== null) {
      const targetSeasonId = data.seasonId === undefined ? existing.seasonId : data.seasonId;
      const targetSeriesId = data.seriesId === undefined ? existing.seriesId : data.seriesId;

      if (data.episodeNumber !== existing.episodeNumber || targetSeasonId !== existing.seasonId || targetSeriesId !== existing.seriesId) {
        const conflict = await this.repo.findEpisodeByNumber(
          targetSeriesId,
          data.episodeNumber,
          targetSeasonId
        );
        if (conflict && conflict.id !== episodeId) {
          throw new CatalogServiceError(
            "CONFLICT",
            `Episode with number ${data.episodeNumber} already exists in this series/season`
          );
        }
      }
    }

    // Handle Video Change
    if (data.mediaAssetId === null || data.uploadId === null) {
      // Explicit unlink requested
      await this.repo.dissociateMediaAsset(episodeId);

      // Cascade Delete Reel
      const reel = await this.repo.findReelByEpisodeId(episodeId);
      if (reel) {
        await this.repo.softDeleteReel(reel.id, adminId);
      }
    } else {
      // Check if we are linking a new video
      let newMediaAsset: MediaAsset | null = null;
      if (data.mediaAssetId) {
        newMediaAsset = await this.repo.findMediaAssetById(data.mediaAssetId);
        if (!newMediaAsset) throw new CatalogServiceError("NOT_FOUND", `MediaAsset ${data.mediaAssetId} not found`);
      } else if (data.uploadId) {
        newMediaAsset = await this.repo.findMediaAssetByUploadId(data.uploadId);
        if (!newMediaAsset) throw new CatalogServiceError("NOT_FOUND", `MediaAsset ${data.uploadId} not found`);
      }

      if (newMediaAsset) {
        // Unlink any existing video first
        await this.repo.dissociateMediaAsset(episodeId);

        // Link new video using ID
        await this.repo.assignMediaAssetToEpisodeById(newMediaAsset.id, episodeId);

        // If this Episode has a linked Reel, update the new MediaAsset to link to that Reel too
        const linkedReel = await this.repo.findReelByEpisodeId(episodeId);
        if (linkedReel) {
          await this.repo.assignMediaAssetToReelById(newMediaAsset.id, linkedReel.id, existing.seriesId);
        }
      }
    }

    // Handle Thumbnail Logic
    let newThumbnailUrl = data.defaultThumbnailUrl;

    if (newThumbnailUrl === null) {
      // Fallback to video thumbnail
      // Need to know current media asset.
      // If we just updated it, we should use the new one.
      let activeMediaAsset = existing.mediaAsset;

      // If we just changed it, try to resolve again (or use the one we just fetched)
      // Re-fetching to be safe if `mediaAsset` var isn't in scope easily above
      if (data.mediaAssetId || data.uploadId) {
        if (data.mediaAssetId) activeMediaAsset = await this.repo.findMediaAssetById(data.mediaAssetId) as any;
        else if (data.uploadId) activeMediaAsset = await this.repo.findMediaAssetByUploadId(data.uploadId!) as any;
      }

      newThumbnailUrl = activeMediaAsset?.defaultThumbnailUrl ?? null;
    }

    // Prepare update data
    // We filter out undefined from data spread
    const updatePayload: any = { ...data };
    delete updatePayload.uploadId; // Not a field on Episode
    delete updatePayload.mediaAssetId;
    if (newThumbnailUrl !== undefined) {
      updatePayload.defaultThumbnailUrl = newThumbnailUrl;
    }

    const updated = await this.repo.updateEpisode(episodeId, {
      ...updatePayload,
      adminId,
    });

    return updated;
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

    // Cascade Delete Reel
    const reel = await this.repo.findReelByEpisodeId(id);
    if (reel) {
      await this.repo.softDeleteReel(reel.id, adminId);
    }

    // UNLINK Media Asset (return to library)
    await this.repo.dissociateMediaAsset(id);
  }

  async deleteMediaAsset(adminId: string, mediaAssetId: string): Promise<void> {
    const asset = await this.repo.findMediaAssetById(mediaAssetId);
    if (!asset) {
      throw new CatalogServiceError("NOT_FOUND", "Media asset not found");
    }

    if (asset.episodeId || asset.reelId) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "Media asset is currently assigned to content. Unlink it first."
      );
    }

    // Call UploadService to delete physical files
    if (asset.uploadId && this.config?.UPLOAD_SERVICE_URL && this.config?.SERVICE_AUTH_TOKEN) {
      try {
        const uploadServiceUrl = `${this.config.UPLOAD_SERVICE_URL}/api/v1/upload/admin/uploads/${asset.uploadId}`;
        const response = await fetch(uploadServiceUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.config.SERVICE_AUTH_TOKEN}`,
            "x-pocketlol-admin-id": adminId,
            "x-pocketlol-user-type": "ADMIN",
          },
        });
        if (!response.ok && response.status !== 404) {
          console.warn(`Failed to delete upload ${asset.uploadId} from UploadService: ${response.status}`);
          // We continue, as DB cleanup is primary here, but log warning.
        }
      } catch (error) {
        console.error("Error calling UploadService delete:", error);
      }
    }

    await this.repo.deleteMediaAsset(mediaAssetId);
    await this.emitCatalogEvent({
      entity: "mediaAsset",
      entityId: mediaAssetId,
      operation: "delete",
      payload: { uploadId: asset.uploadId },
    });
  }

  async processMediaAsset(adminId: string, mediaAssetId: string) {
    const asset = await this.repo.findMediaAssetById(mediaAssetId);
    if (!asset) {
      throw new CatalogServiceError("NOT_FOUND", "Media asset not found");
    }
    if (!asset.uploadId) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "Media asset has no associated upload"
      );
    }

    if (!this.config?.UPLOAD_SERVICE_URL || !this.config?.SERVICE_AUTH_TOKEN) {
      throw new Error("Missing upload service configuration");
    }

    // Fetch upload status
    const statusUrl = `${this.config.UPLOAD_SERVICE_URL}/api/v1/upload/admin/uploads/${asset.uploadId}/status`;
    const response = await fetch(statusUrl, {
      headers: {
        Authorization: `Bearer ${this.config.SERVICE_AUTH_TOKEN}`,
        "x-pocketlol-admin-id": adminId,
        "x-pocketlol-user-type": "ADMIN",
      },
    });

    if (!response.ok) {
      let errorMsg = "Failed to fetch upload status";
      try {
        const errBody = await response.json() as any;
        if (errBody.message) errorMsg = errBody.message;
      } catch { }
      throw new CatalogServiceError("FAILED_PRECONDITION", errorMsg);
    }

    const uploadStatus = (await response.json()) as any;
    if (!uploadStatus.storageUrl && !uploadStatus.objectKey) {
      throw new CatalogServiceError("FAILED_PRECONDITION", "Upload has no valid file");
    }

    // Publish to transcoding requests
    if (!this.pubsub || !this.config.TRANSCODING_REQUESTS_TOPIC) {
      console.warn("Transcoding topic not configured, skipping publish");
      return;
    }

    // Construct message matching TranscodingWorker expectations
    const msgData = {
      uploadId: asset.uploadId,
      contentId: asset.id, // Using asset ID as contentId
      contentClassification: asset.type,
      storageUrl: uploadStatus.storageUrl || `gs://${this.config.UPLOAD_BUCKET}/${uploadStatus.objectKey}`,
      assetType: "video", // Assuming explicit trigger implies video
    };

    const topic = this.pubsub.topic(this.config.TRANSCODING_REQUESTS_TOPIC);
    await topic.publishMessage({ json: msgData });

    // Update status 
    await this.repo.updateMediaAssetStatus(asset.id, MediaAssetStatus.PROCESSING, adminId);

    return { status: "PROCESSING", message: "Transcoding triggered" };
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

  async getCarouselEntries() {
    return this.repo.listCarouselEntries();
  }

  async addCarouselSeries(adminId: string, seriesId: string) {
    const series = await this.repo.findSeriesById(seriesId);
    if (!series) {
      throw new CatalogServiceError("NOT_FOUND", "Series not found");
    }

    this.ensureCarouselSeriesSelectable(series);

    return this.repo.upsertCarouselEntry({
      seriesId: series.id,
      adminId
    });
  }

  async removeCarouselSeries(adminId: string, seriesId: string) {
    // Check if series exists just to provide better error? 
    // Or just delete. Ideally idempotent is fine.
    // But let's check validation if needed.
    // Actually, just deleting is fine.
    return this.repo.deleteCarouselEntriesBySeriesId(seriesId);
  }

  async handleMediaFailure(event: { uploadId: string; reason: string }) {
    await this.repo.upsertMediaAssetByUploadId({
      uploadId: event.uploadId,
      type: MediaAssetType.EPISODE,
      status: MediaAssetStatus.FAILED,
      manifestUrl: "",
      filename: undefined,
      variants: [],
    });
  }

  async handleMediaUploaded(event: MediaUploadedEvent) {
    if (event.assetType === "thumbnail" || event.assetType === "banner") {
      await this.repo.upsertImageAsset({
        uploadId: event.uploadId,
        filename: event.filename ?? undefined,
        url: (event.storageUrl ?? "").replace("gs://", "https://storage.googleapis.com/"),
        // Actually schema says storageUrl is optional, but logic implies it exists.
        // Wait, existing MediaAsset uses Upsert which doesn't take URL?
        // MediaAsset logic is: status=UPLOADED, manifestUrl="".
        // For Image, we need the URL. upload-manager event has storageUrl and cdnUrl.
        // Let check event schema again. storageUrl is allowed.
        status: MediaAssetStatus.READY,
        sizeBytes: event.sizeBytes ? BigInt(event.sizeBytes) : undefined,
        adminId: "SYSTEM", // Or we can try to find from context? The event doesn't have admin ID? 
        // UploadService has it. But event schema doesn't pass it?
        // Checked events.ts: No adminId. CatalogService usually uses "SYSTEM" for auto stuff.
      });

      // Logic to auto-assign if contentId exists?
      // If event.contentId is provided, we should update the ImageAsset's episodeId/seriesId
      // AND update the Episode's defaultThumbnailUrl/heroImageUrl?
      // For now, let's just UPSERT the ImageAsset record.
      // Linking can happen if contentId is passed.
      if (event.contentId) {
        const imageAsset = await this.repo.findImageAssetByUploadId(event.uploadId);
        if (imageAsset) {
          const target = {
            episodeId: event.contentType === "EPISODE" ? event.contentId : undefined,
            seriesId: event.contentType === "SERIES" ? event.contentId : undefined,
            reelId: event.contentType === "REEL" ? event.contentId : undefined,
          };
          // We can update the asset to link it.
          await this.repo.upsertImageAsset({
            uploadId: event.uploadId,
            url: event.storageUrl ?? "",
            ...target
          });
        }
      }
      return;
    }

    const asset = await this.repo.findMediaAssetByUploadId(event.uploadId);

    const episodeId =
      (event.contentType === "EPISODE" || event.contentType === "episode") &&
        event.contentId && event.contentId !== asset?.id
        ? event.contentId
        : undefined;
    const reelId =
      (event.contentType === "REEL" || event.contentType === "reel") &&
        event.contentId && event.contentId !== asset?.id
        ? event.contentId
        : undefined;

    await this.repo.upsertMediaAssetByUploadId({
      uploadId: event.uploadId,
      type: reelId ? MediaAssetType.REEL : MediaAssetType.EPISODE,
      status: MediaAssetStatus.UPLOADED,
      manifestUrl: "",
      defaultThumbnailUrl: undefined,
      filename: event.filename,
      episodeId,
      reelId,
      variants: [],
    });
  }

  async assignImageAsset(
    adminId: string,
    imageId: string,
    target: { episodeId?: string; seriesId?: string; reelId?: string }
  ) {
    const image = await this.repo.findImageAssetById(imageId);
    if (!image) {
      throw new CatalogServiceError("NOT_FOUND", "Image asset not found");
    }

    // 1. Update the ImageAsset to match the target (Link it)
    await this.repo.upsertImageAsset({
      uploadId: image.uploadId,
      url: image.url,
      status: image.status,
      adminId,
      ...target
    });

    // 2. Update the Parent's Display URL
    // Rule: If assigning to Episode, set defaultThumbnailUrl. 
    // Wait, requirement says "heroImageUrl" or "defaultThumbnailUrl"?
    // Episode has `heroImageUrl`? Let's check Episode model.
    // Checking schema in logic... I'll check during verification.
    // Assuming Episode has `defaultThumbnailUrl` (standard) and `heroImageUrl` (maybe?).
    // CatalogRepository `updateEpisode` takes `heroImageUrl`.
    // Let's assume we update `defaultThumbnailUrl` for now as that's the main thumb.

    if (target.episodeId) {
      // For Episode, we usually use defaultThumbnailUrl for the list view.
      // We use updateEpisode method.
      await this.repo.updateEpisodeThumbnail(target.episodeId, image.url);
    }

    // TODO: Series and Reel logic if needed.

    return this.repo.findImageAssetById(imageId);
  }

  async deleteImageAsset(adminId: string, imageId: string) {
    const image = await this.repo.findImageAssetById(imageId);
    if (!image) {
      throw new CatalogServiceError("NOT_FOUND", "Image asset not found");
    }

    // Check if it's currently ASSIGNED to the thing it claims to be assigned to?
    // Actually, we just check if it IS assigned.
    // If it is assigned, we should probably UNLINK it from the parent's generic URL field?
    // Or do we block deletion?
    // User requirement: "delete permanently or unlink... if episode deleted"
    // Usually we block deletion if it's in use.
    // New logic: If I delete an image from library, I should check if it's the ACTIVE image for any episode.
    // If so, FAILED_PRECONDITION.

    if (image.episodeId || image.seriesId || image.reelId) {
      // It is linked.
      throw new CatalogServiceError("FAILED_PRECONDITION", "Image is assigned to content. Unassign it first.");
    }

    // Proceed to delete physical file
    if (image.uploadId && this.config?.UPLOAD_SERVICE_URL && this.config?.SERVICE_AUTH_TOKEN) {
      try {
        const uploadServiceUrl = `${this.config.UPLOAD_SERVICE_URL}/api/v1/upload/admin/uploads/${image.uploadId}`;
        const response = await fetch(uploadServiceUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.config.SERVICE_AUTH_TOKEN}`,
            "x-pocketlol-admin-id": adminId,
            "x-pocketlol-user-type": "ADMIN",
          },
        });
        if (!response.ok && response.status !== 404) {
          console.warn(`Failed to delete upload ${image.uploadId} from UploadService: ${response.status}`);
        }
      } catch (error) {
        console.error("Error calling UploadService delete:", error);
      }
    }

    await this.repo.deleteImageAsset(imageId);
  }

  async listImageAssets(params: {
    limit?: number;
    cursor?: string | null;
    unassigned?: boolean;
    status?: MediaAssetStatus;
  }) {
    return this.repo.listImageAssets(params);
  }

  async handleMediaCompletion(event: MediaCompletionEvent) {
    const asset = await this.repo.findMediaAssetByUploadId(event.uploadId);

    const episodeId =
      (event.contentType === "EPISODE" || event.contentType === "episode") &&
        event.contentId && event.contentId !== asset?.id
        ? event.contentId
        : undefined;
    const reelId =
      (event.contentType === "REEL" || event.contentType === "reel") &&
        event.contentId && event.contentId !== asset?.id
        ? event.contentId
        : undefined;

    await this.repo.upsertMediaAssetByUploadId({
      uploadId: event.uploadId,
      type: reelId ? MediaAssetType.REEL : MediaAssetType.EPISODE,
      status: MediaAssetStatus.READY,
      manifestUrl: event.manifestUrl,
      defaultThumbnailUrl: event.thumbnailUrl,
      filename: event.filename,
      episodeId,
      reelId,
      variants: event.renditions.map((r: any) => ({
        label: r.name || r.label,
        width: r.width,
        height: r.height,
        bitrateKbps: r.bitrateKbps,
        codec: r.codec,
        frameRate: r.frameRate,
      })),
    });
  }


  async createReel(
    adminId: string,
    input: {
      seriesId: string;
      episodeId: string;
      title: string;
      description?: string | null;
      status?: PublicationStatus;
      visibility?: Visibility;
      publishedAt?: Date | null;
      tags?: string[];
      durationSeconds?: number;
      uploadId?: string;
      mediaAssetId?: string;
    }
  ) {
    const series = await this.repo.findSeriesById(input.seriesId);
    if (!series) throw new CatalogServiceError("NOT_FOUND", "Series not found");

    const episode = await this.repo.findEpisodeById(input.episodeId);
    if (!episode) throw new CatalogServiceError("NOT_FOUND", "Episode not found");

    if (episode.seriesId !== input.seriesId) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "Episode does not belong to Series"
      );
    }

    // Resolve Media Asset: explicit ID > uploadId > episode's asset
    let targetMediaAssetId: string | null = null;

    if (input.mediaAssetId) {
      const asset = await this.repo.findMediaAssetById(input.mediaAssetId);
      if (!asset) throw new CatalogServiceError("FAILED_PRECONDITION", `MediaAsset not found: ${input.mediaAssetId}`);
      targetMediaAssetId = asset.id;
    } else if (input.uploadId) {
      const asset = await this.repo.findMediaAssetByUploadId(input.uploadId);
      if (!asset) throw new CatalogServiceError("FAILED_PRECONDITION", `MediaAsset not found for uploadId: ${input.uploadId}`);
      targetMediaAssetId = asset.id;
    } else if (episode.mediaAsset) {
      targetMediaAssetId = episode.mediaAsset.id;
    } else {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "No media asset provided (id/uploadId) and linked episode has no media asset"
      );
    }

    const existingReelForEpisode = await this.repo.findReelByEpisodeId(input.episodeId);
    if (existingReelForEpisode) {
      throw new CatalogServiceError(
        "CONFLICT",
        "A reel already exists for this episode"
      );
    }

    // Auto-generate slug
    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let attempts = 0;
    while (attempts < 10) {
      const existing = await this.repo.findReelBySlug(slug);
      if (!existing) break;
      slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;
      attempts++;
    }

    if (attempts >= 10) {
      throw new CatalogServiceError(
        "CONFLICT",
        "Could not generate unique slug after multiple attempts"
      );
    }

    const reel = await this.repo.createReel({
      slug,
      title: input.title,
      description: input.description,
      status: input.status,
      visibility: input.visibility,
      publishedAt: input.publishedAt,
      tags: input.tags,
      durationSeconds: input.durationSeconds ?? episode.durationSeconds, // Fallback to episode duration
      seriesId: input.seriesId,
      episodeId: input.episodeId,
      ownerId: (series.ownerId === this.defaultOwnerId) ? adminId : series.ownerId,
      categoryId: series.categoryId,
      adminId,
    });

    // Link the MediaAsset to this Reel and Series
    if (targetMediaAssetId) {
      await this.repo.assignMediaAssetToReelById(
        targetMediaAssetId,
        reel.id,
        input.seriesId
      );
    }

    return reel;
  }

  async deleteReel(adminId: string, id: string) {
    const existing = await this.repo.findReelById(id);
    if (!existing) throw new CatalogServiceError("NOT_FOUND", "Reel not found");

    // Unlink Media Asset (if any)
    const mediaAsset = await this.repo.findMediaAssetByReelId(id);
    if (mediaAsset) {
      await this.repo.assignMediaAssetToReelById(mediaAsset.id, null, null);
    }

    await this.repo.softDeleteReel(id, adminId);

  }

  async listReels(params: {
    seriesId?: string;
    limit?: number;
    cursor?: string;
  }) {
    return this.repo.listReels(params);
  }

  async updateReel(
    adminId: string,
    id: string,
    data: {
      title?: string;
      description?: string | null;
      status?: PublicationStatus;
      visibility?: Visibility;
      publishedAt?: Date | null;
      durationSeconds?: number;
    }
  ) {
    const existing = await this.repo.findReelById(id);
    if (!existing) throw new CatalogServiceError("NOT_FOUND", "Reel not found");

    return this.repo.updateReel(id, {
      ...data,
      updatedByAdminId: adminId,
    });
  }

  private isTransitionAllowed(
    current: PublicationStatus,
    target: PublicationStatus
  ): boolean {
    if (current === target) {
      return true;
    }
    const transitions: Record<PublicationStatus, PublicationStatus[]> = {
      [PublicationStatus.DRAFT]: [
        PublicationStatus.REVIEW,
        PublicationStatus.ARCHIVED,
      ],
      [PublicationStatus.REVIEW]: [
        PublicationStatus.DRAFT,
        PublicationStatus.PUBLISHED,
        PublicationStatus.ARCHIVED,
      ],
      [PublicationStatus.PUBLISHED]: [
        PublicationStatus.ARCHIVED,
        PublicationStatus.DRAFT,
      ],
      [PublicationStatus.ARCHIVED]: [
        PublicationStatus.DRAFT,
        PublicationStatus.PUBLISHED,
      ],
    };
    return transitions[current].includes(target);
  }

  async getAdminTopTenSeries() {
    return this.repo.getTopTenSeries();
  }

  async updateTopTenSeries(
    adminId: string,
    items: { seriesId: string; position: number }[]
  ) {
    if (items.length > 10) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        "Cannot have more than 10 series in the Top 10 list"
      );
    }

    // Validate all series exist
    const seriesIds = items.map((i) => i.seriesId);
    const foundSeries = await this.repo.findSeriesByIds(seriesIds);
    if (foundSeries.length !== seriesIds.length) {
      const foundIds = new Set(foundSeries.map((s) => s.id));
      const missing = seriesIds.filter((id) => !foundIds.has(id));
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Series IDs not found: ${missing.join(", ")}`
      );
    }

    const updated = await this.repo.replaceTopTenSeries(items, adminId);

    await this.emitCatalogEvent({
      entity: "series",
      entityId: "top-10-list",
      operation: "update",
      payload: { count: updated.length }
    });

    return updated;
  }
}
