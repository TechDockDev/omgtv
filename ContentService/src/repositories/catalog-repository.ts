import {
  CarouselEntry,
  Category,
  Episode,
  MediaAsset,
  MediaAssetStatus,
  MediaAssetVariant,
  MediaAssetType,
  Prisma,
  PublicationStatus,
  Reel,
  Season,
  Series,
  Tag,
  Visibility,
} from "@prisma/client";
import { getPrisma } from "../lib/prisma";

export type PaginationParams = {
  limit?: number;
  cursor?: string | null;
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export type EpisodeWithRelations = Episode & {
  series: Series & {
    category: Category | null;
  };
  season: Season | null;
  mediaAsset: (MediaAsset & { variants: MediaAssetVariant[] }) | null;
};

export type SeriesWithRelations = Series & {
  category: Category | null;
  seasons: Array<
    Season & {
      episodes: EpisodeWithRelations[];
    }
  >;
  standaloneEpisodes: EpisodeWithRelations[];
};

export type ReelWithRelations = Reel & {
  mediaAsset: (MediaAsset & { variants: MediaAssetVariant[] }) | null;
  category: Category | null;
};

export type CarouselEntryWithContent = CarouselEntry & {
  episode: EpisodeWithRelations | null;
  series: (Series & { category: Category | null }) | null;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function normalizeLimit(limit?: number) {
  if (!limit) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
}

export class CatalogRepository {
  private readonly prisma = getPrisma();

  async findCategoryById(id: string) {
    return this.prisma.category.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findCategoryBySlug(slug: string) {
    return this.prisma.category.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  async createCategory(data: {
    slug: string;
    name: string;
    description?: string | null;
    displayOrder?: number | null;
    adminId?: string;
  }) {
    return this.prisma.category.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        displayOrder: data.displayOrder ?? null,
        createdByAdminId: data.adminId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async updateCategory(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      displayOrder?: number | null;
      slug?: string;
      adminId?: string;
    }
  ) {
    return this.prisma.category.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        displayOrder: data.displayOrder,
        slug: data.slug,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async softDeleteCategory(id: string, adminId?: string) {
    return this.prisma.category.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedByAdminId: adminId,
      },
    });
  }

  async listCategories(
    params: PaginationParams
  ): Promise<PaginatedResult<Category>> {
    const limit = normalizeLimit(params.limit);
    const rows = await this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      skip: params.cursor ? 1 : 0,
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: rows, nextCursor };
  }

  async createTag(data: {
    slug: string;
    name: string;
    description?: string | null;
    adminId?: string;
  }) {
    return this.prisma.tag.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        createdByAdminId: data.adminId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async listTags(params: PaginationParams): Promise<PaginatedResult<Tag>> {
    const limit = normalizeLimit(params.limit);
    const rows = await this.prisma.tag.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      skip: params.cursor ? 1 : 0,
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: rows, nextCursor };
  }

  async findTagsByNames(names: string[]) {
    if (names.length === 0) {
      return [] as Tag[];
    }
    return this.prisma.tag.findMany({
      where: {
        name: { in: names },
        deletedAt: null,
      },
    });
  }

  async findTagBySlug(slug: string) {
    return this.prisma.tag.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  async createSeries(data: {
    slug: string;
    title: string;
    synopsis?: string | null;
    heroImageUrl?: string | null;
    bannerImageUrl?: string | null;
    tags?: string[];
    status?: PublicationStatus;
    visibility?: Visibility;
    releaseDate?: Date | null;
    ownerId: string;
    categoryId?: string | null;
    adminId?: string;
  }) {
    return this.prisma.series.create({
      data: {
        slug: data.slug,
        title: data.title,
        synopsis: data.synopsis ?? null,
        heroImageUrl: data.heroImageUrl ?? null,
        bannerImageUrl: data.bannerImageUrl ?? null,
        tags: data.tags ?? [],
        status: data.status ?? PublicationStatus.DRAFT,
        visibility: data.visibility ?? Visibility.PUBLIC,
        releaseDate: data.releaseDate ?? null,
        ownerId: data.ownerId,
        categoryId: data.categoryId ?? null,
        createdByAdminId: data.adminId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async updateSeries(
    id: string,
    data: {
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
      adminId?: string;
    }
  ) {
    return this.prisma.series.update({
      where: { id },
      data: {
        title: data.title,
        synopsis: data.synopsis,
        heroImageUrl: data.heroImageUrl,
        bannerImageUrl: data.bannerImageUrl,
        tags: data.tags,
        status: data.status,
        visibility: data.visibility,
        releaseDate: data.releaseDate,
        categoryId: data.categoryId,
        slug: data.slug,
        ownerId: data.ownerId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async findSeriesById(id: string) {
    return this.prisma.series.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findSeriesBySlug(slug: string) {
    return this.prisma.series.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  async findSeriesByIds(ids: string[]) {
    if (ids.length === 0) {
      return [] as Array<Series & { category: Category | null }>;
    }
    return this.prisma.series.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      include: {
        category: true,
      },
    });
  }

  async softDeleteSeries(id: string, adminId?: string) {
    return this.prisma.series.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedByAdminId: adminId,
      },
    });
  }

  async createSeason(data: {
    seriesId: string;
    sequenceNumber: number;
    title: string;
    synopsis?: string | null;
    releaseDate?: Date | null;
    adminId?: string;
  }) {
    return this.prisma.season.create({
      data: {
        seriesId: data.seriesId,
        sequenceNumber: data.sequenceNumber,
        title: data.title,
        synopsis: data.synopsis ?? null,
        releaseDate: data.releaseDate ?? null,
        createdByAdminId: data.adminId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async findSeasonById(id: string) {
    return this.prisma.season.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async createEpisode(data: {
    slug: string;
    seriesId: string;
    seasonId?: string | null;
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
    captions?: Prisma.InputJsonValue | null;
    tags?: string[];
    adminId?: string;
  }) {
    return this.prisma.episode.create({
      data: {
        slug: data.slug,
        seriesId: data.seriesId,
        seasonId: data.seasonId ?? null,
        title: data.title,
        synopsis: data.synopsis ?? null,
        durationSeconds: data.durationSeconds,
        status: data.status ?? PublicationStatus.DRAFT,
        visibility: data.visibility ?? Visibility.PUBLIC,
        publishedAt: data.publishedAt ?? null,
        availabilityStart: data.availabilityStart ?? null,
        availabilityEnd: data.availabilityEnd ?? null,
        heroImageUrl: data.heroImageUrl ?? null,
        defaultThumbnailUrl: data.defaultThumbnailUrl ?? null,
        captions:
          data.captions === undefined
            ? undefined
            : (data.captions ?? Prisma.JsonNull),
        tags: data.tags ?? [],
        createdByAdminId: data.adminId,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async updateEpisode(
    id: string,
    data: {
      title?: string;
      synopsis?: string | null;
      durationSeconds?: number;
      status?: PublicationStatus;
      visibility?: Visibility;
      publishedAt?: Date | null;
      availabilityStart?: Date | null;
      availabilityEnd?: Date | null;
      heroImageUrl?: string | null;
      defaultThumbnailUrl?: string | null;
      captions?: Prisma.InputJsonValue | null;
      seasonId?: string | null;
      slug?: string;
      tags?: string[];
      adminId?: string;
    }
  ) {
    return this.prisma.episode.update({
      where: { id },
      data: {
        title: data.title,
        synopsis: data.synopsis,
        durationSeconds: data.durationSeconds,
        status: data.status,
        visibility: data.visibility,
        publishedAt: data.publishedAt,
        availabilityStart: data.availabilityStart,
        availabilityEnd: data.availabilityEnd,
        heroImageUrl: data.heroImageUrl,
        defaultThumbnailUrl: data.defaultThumbnailUrl,
        captions:
          data.captions === undefined
            ? undefined
            : (data.captions ?? Prisma.JsonNull),
        seasonId: data.seasonId,
        slug: data.slug,
        tags: data.tags,
        updatedByAdminId: data.adminId,
      },
    });
  }

  async updateEpisodeTags(id: string, tags: string[], adminId?: string) {
    return this.prisma.episode.update({
      where: { id },
      data: { tags, updatedByAdminId: adminId },
      select: { id: true, tags: true },
    });
  }

  async findEpisodeById(id: string) {
    return this.prisma.episode.findFirst({
      where: { id, deletedAt: null },
      include: {
        mediaAsset: {
          include: { variants: true },
        },
      },
    });
  }

  async findEpisodesWithRelationsByIds(ids: string[]) {
    if (ids.length === 0) {
      return [] as EpisodeWithRelations[];
    }
    const rows = await this.prisma.episode.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      include: {
        mediaAsset: {
          include: { variants: true },
        },
        series: {
          include: {
            category: true,
          },
        },
        season: true,
      },
    });
    return rows as EpisodeWithRelations[];
  }

  async findReelById(id: string) {
    return this.prisma.reel.findFirst({
      where: { id, deletedAt: null },
      include: {
        mediaAsset: {
          include: { variants: true },
        },
        category: true,
      },
    });
  }

  async softDeleteEpisode(id: string, adminId?: string) {
    return this.prisma.episode.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedByAdminId: adminId,
      },
    });
  }

  async updateReelTags(id: string, tags: string[], adminId?: string) {
    return this.prisma.reel.update({
      where: { id },
      data: { tags, updatedByAdminId: adminId },
      select: { id: true, tags: true },
    });
  }

  async updateEpisodeStatus(
    id: string,
    status: PublicationStatus,
    adminId?: string,
    publishedAt?: Date | null
  ) {
    return this.prisma.episode.update({
      where: { id },
      data: {
        status,
        publishedAt,
        updatedByAdminId: adminId,
      },
    });
  }

  async upsertEpisodeAsset(data: {
    episodeId: string;
    adminId?: string;
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
  }) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.mediaAsset.upsert({
        where: { episodeId: data.episodeId },
        update: {
          status: data.status,
          sourceUploadId: data.sourceUploadId ?? null,
          streamingAssetId: data.streamingAssetId ?? null,
          manifestUrl: data.manifestUrl ?? null,
          defaultThumbnailUrl: data.defaultThumbnailUrl ?? null,
          updatedByAdminId: data.adminId,
          variants: {
            deleteMany: {},
            create: data.variants.map((variant) => ({
              label: variant.label,
              width: variant.width ?? null,
              height: variant.height ?? null,
              bitrateKbps: variant.bitrateKbps ?? null,
              codec: variant.codec ?? null,
              frameRate: variant.frameRate ?? null,
            })),
          },
        },
        create: {
          episodeId: data.episodeId,
          type: MediaAssetType.EPISODE,
          status: data.status,
          sourceUploadId: data.sourceUploadId ?? null,
          streamingAssetId: data.streamingAssetId ?? null,
          manifestUrl: data.manifestUrl ?? null,
          defaultThumbnailUrl: data.defaultThumbnailUrl ?? null,
          createdByAdminId: data.adminId,
          updatedByAdminId: data.adminId,
          variants: {
            create: data.variants.map((variant) => ({
              label: variant.label,
              width: variant.width ?? null,
              height: variant.height ?? null,
              bitrateKbps: variant.bitrateKbps ?? null,
              codec: variant.codec ?? null,
              frameRate: variant.frameRate ?? null,
            })),
          },
        },
        include: {
          variants: true,
        },
      });

      await tx.episode.update({
        where: { id: data.episodeId },
        data: {
          defaultThumbnailUrl: data.defaultThumbnailUrl ?? null,
          updatedByAdminId: data.adminId,
        },
      });

      return asset;
    });
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
    const limit = normalizeLimit(params.limit);
    const statusFilter: Prisma.EnumPublicationStatusFilter = params.status
      ? { equals: params.status }
      : { in: [PublicationStatus.REVIEW, PublicationStatus.DRAFT] };
    const where: Prisma.EpisodeWhereInput = {
      deletedAt: null,
      status: statusFilter,
    };

    const rows = await this.prisma.episode.findMany({
      where,
      include: {
        mediaAsset: {
          select: {
            status: true,
            manifestUrl: true,
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: limit + 1,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      skip: params.cursor ? 1 : 0,
    });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: rows,
      nextCursor,
    };
  }

  async listFeedEpisodes(params: {
    limit?: number;
    cursor?: string | null;
    now?: Date;
  }): Promise<PaginatedResult<EpisodeWithRelations>> {
    const limit = normalizeLimit(params.limit);
    const now = params.now ?? new Date();
    const availabilityFilter: Prisma.EpisodeWhereInput = {
      OR: [{ availabilityStart: null }, { availabilityStart: { lte: now } }],
      AND: [{ availabilityEnd: null }, { availabilityEnd: { gte: now } }],
    };

    const rows = await this.prisma.episode.findMany({
      where: {
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
        publishedAt: { lte: now },
        ...availabilityFilter,
        mediaAsset: {
          is: {
            status: MediaAssetStatus.READY,
            deletedAt: null,
          },
        },
        series: {
          deletedAt: null,
          status: PublicationStatus.PUBLISHED,
          visibility: Visibility.PUBLIC,
        },
      },
      include: {
        mediaAsset: {
          include: {
            variants: true,
          },
        },
        series: {
          include: {
            category: true,
          },
        },
        season: true,
      },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      skip: params.cursor ? 1 : 0,
    });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: rows as EpisodeWithRelations[],
      nextCursor,
    };
  }

  async replaceCarouselEntries(params: {
    adminId: string;
    items: Array<{
      position: number;
      seriesId?: string | null;
      episodeId?: string | null;
    }>;
  }) {
    await this.prisma.$transaction(async (tx) => {
      await tx.carouselEntry.deleteMany({});
      if (params.items.length === 0) {
        return;
      }
      for (const item of params.items) {
        await tx.carouselEntry.create({
          data: {
            position: item.position,
            seriesId: item.seriesId ?? null,
            episodeId: item.episodeId ?? null,
            createdByAdminId: params.adminId,
            updatedByAdminId: params.adminId,
          },
        });
      }
    });
  }

  async listCarouselEntries(): Promise<CarouselEntryWithContent[]> {
    const rows = await this.prisma.carouselEntry.findMany({
      where: {
        OR: [
          {
            episodeId: { not: null },
            episode: {
              is: {
                deletedAt: null,
                status: PublicationStatus.PUBLISHED,
                visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
                mediaAsset: {
                  is: {
                    status: MediaAssetStatus.READY,
                    deletedAt: null,
                  },
                },
              },
            },
          },
          {
            seriesId: { not: null },
            series: {
              is: {
                deletedAt: null,
                status: PublicationStatus.PUBLISHED,
                visibility: Visibility.PUBLIC,
              },
            },
          },
        ],
      },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: {
        series: {
          include: {
            category: true,
          },
        },
        episode: {
          include: {
            mediaAsset: {
              include: {
                variants: true,
              },
            },
            series: {
              include: {
                category: true,
              },
            },
            season: true,
          },
        },
      },
    });
    return rows as CarouselEntryWithContent[];
  }

  async listPublishedReels(params: {
    limit?: number;
    cursor?: string | null;
    now?: Date;
  }): Promise<PaginatedResult<ReelWithRelations>> {
    const limit = normalizeLimit(params.limit);
    const now = params.now ?? new Date();

    const rows = await this.prisma.reel.findMany({
      where: {
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
        OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
        mediaAsset: {
          is: {
            status: MediaAssetStatus.READY,
            deletedAt: null,
          },
        },
      },
      include: {
        mediaAsset: {
          include: {
            variants: true,
          },
        },
        category: true,
      },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      cursor: params.cursor ? { id: params.cursor } : undefined,
      skip: params.cursor ? 1 : 0,
    });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: rows as ReelWithRelations[],
      nextCursor,
    };
  }

  async findSeriesForViewer(params: {
    slug: string;
    now?: Date;
  }): Promise<SeriesWithRelations | null> {
    const now = params.now ?? new Date();
    const availabilityFilter: Prisma.EpisodeWhereInput = {
      OR: [{ availabilityStart: null }, { availabilityStart: { lte: now } }],
      AND: [{ availabilityEnd: null }, { availabilityEnd: { gte: now } }],
    };

    const series = await this.prisma.series.findFirst({
      where: {
        slug: params.slug,
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        OR: [{ releaseDate: null }, { releaseDate: { lte: now } }],
      },
      include: {
        category: true,
        seasons: {
          where: { deletedAt: null },
          orderBy: { sequenceNumber: "asc" },
          include: {
            episodes: {
              where: {
                deletedAt: null,
                status: PublicationStatus.PUBLISHED,
                visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
                publishedAt: { lte: now },
                ...availabilityFilter,
                mediaAsset: {
                  is: {
                    status: MediaAssetStatus.READY,
                    deletedAt: null,
                  },
                },
              },
              include: {
                mediaAsset: {
                  include: {
                    variants: true,
                  },
                },
                series: {
                  include: {
                    category: true,
                  },
                },
                season: true,
              },
              orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            },
          },
        },
        episodes: {
          where: {
            deletedAt: null,
            seasonId: null,
            status: PublicationStatus.PUBLISHED,
            visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
            publishedAt: { lte: now },
            ...availabilityFilter,
            mediaAsset: {
              is: {
                status: MediaAssetStatus.READY,
                deletedAt: null,
              },
            },
          },
          include: {
            mediaAsset: {
              include: {
                variants: true,
              },
            },
            series: {
              include: {
                category: true,
              },
            },
            season: true,
          },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        },
      },
    });

    if (!series) {
      return null;
    }

    const { episodes = [], seasons, ...rest } = series;
    const standaloneEpisodes = episodes as EpisodeWithRelations[];
    const normalizedSeasons = seasons.map((season) => ({
      ...season,
      episodes: (season.episodes ?? []) as EpisodeWithRelations[],
    }));

    return {
      ...(rest as Series & { category: Category | null }),
      seasons: normalizedSeasons,
      standaloneEpisodes,
    };
  }

  async listRelatedSeries(params: {
    seriesId: string;
    categoryId?: string | null;
    limit?: number;
    now?: Date;
  }): Promise<Array<Series & { category: Category | null }>> {
    const limit = normalizeLimit(params.limit);
    const now = params.now ?? new Date();
    return this.prisma.series.findMany({
      where: {
        id: { not: params.seriesId },
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        OR: [{ releaseDate: null }, { releaseDate: { lte: now } }],
        categoryId: params.categoryId ?? undefined,
        episodes: {
          some: {
            deletedAt: null,
            status: PublicationStatus.PUBLISHED,
            mediaAsset: {
              is: {
                status: MediaAssetStatus.READY,
                deletedAt: null,
              },
            },
          },
        },
      },
      include: {
        category: true,
      },
      orderBy: [{ releaseDate: "desc" }, { updatedAt: "desc" }],
      take: limit,
    }) as Promise<Array<Series & { category: Category | null }>>;
  }

  async findEpisodeForViewer(
    id: string,
    now = new Date()
  ): Promise<EpisodeWithRelations | null> {
    const availabilityFilter: Prisma.EpisodeWhereInput = {
      OR: [{ availabilityStart: null }, { availabilityStart: { lte: now } }],
      AND: [{ availabilityEnd: null }, { availabilityEnd: { gte: now } }],
    };

    return this.prisma.episode.findFirst({
      where: {
        id,
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: { in: [Visibility.PUBLIC, Visibility.UNLISTED] },
        publishedAt: { lte: now },
        ...availabilityFilter,
        mediaAsset: {
          is: {
            status: MediaAssetStatus.READY,
            deletedAt: null,
          },
        },
        series: {
          deletedAt: null,
          status: PublicationStatus.PUBLISHED,
          visibility: Visibility.PUBLIC,
        },
      },
      include: {
        mediaAsset: {
          include: {
            variants: true,
          },
        },
        series: {
          include: {
            category: true,
          },
        },
        season: true,
      },
    }) as Promise<EpisodeWithRelations | null>;
  }

  async countUnpublishedContent(): Promise<{
    series: number;
    seasons: number;
    episodes: number;
    assetsAwaiting: number;
  }> {
    const [series, seasons, episodes, assetsAwaiting] = await Promise.all([
      this.prisma.series.count({
        where: {
          deletedAt: null,
          status: { not: PublicationStatus.PUBLISHED },
        },
      }),
      this.prisma.season.count({
        where: {
          deletedAt: null,
          status: { not: PublicationStatus.PUBLISHED },
        },
      }),
      this.prisma.episode.count({
        where: {
          deletedAt: null,
          status: { not: PublicationStatus.PUBLISHED },
        },
      }),
      this.prisma.mediaAsset.count({
        where: {
          deletedAt: null,
          status: {
            in: [MediaAssetStatus.PENDING, MediaAssetStatus.PROCESSING],
          },
          episode: {
            is: {
              deletedAt: null,
            },
          },
        },
      }),
    ]);
    return { series, seasons, episodes, assetsAwaiting };
  }

  async countScheduledReleases(): Promise<{
    next24Hours: number;
    next7Days: number;
    future: number;
  }> {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const baseWhere: Prisma.EpisodeWhereInput = {
      deletedAt: null,
      status: {
        in: [
          PublicationStatus.DRAFT,
          PublicationStatus.REVIEW,
          PublicationStatus.PUBLISHED,
        ],
      },
    };

    const next24Hours = await this.prisma.episode.count({
      where: {
        ...baseWhere,
        OR: [
          { publishedAt: { gt: now, lte: in24Hours } },
          { availabilityStart: { gt: now, lte: in24Hours } },
        ],
      },
    });

    const next7Days = await this.prisma.episode.count({
      where: {
        ...baseWhere,
        OR: [
          { publishedAt: { gt: in24Hours, lte: in7Days } },
          { availabilityStart: { gt: in24Hours, lte: in7Days } },
        ],
      },
    });

    const future = await this.prisma.episode.count({
      where: {
        ...baseWhere,
        OR: [
          { publishedAt: { gt: in7Days } },
          { availabilityStart: { gt: in7Days } },
        ],
      },
    });

    return { next24Hours, next7Days, future };
  }

  async getIngestionLatencyStats(days: number): Promise<{
    averageSeconds: number | null;
    p95Seconds: number | null;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ avg_seconds: number | null; p95_seconds: number | null }>
    >(Prisma.sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (ma."updatedAt" - e."createdAt"))) AS avg_seconds,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (ma."updatedAt" - e."createdAt"))
        ) AS p95_seconds
      FROM "MediaAsset" ma
      JOIN "Episode" e ON e."id" = ma."episodeId"
      WHERE ma."status" = ${MediaAssetStatus.READY}
        AND ma."deletedAt" IS NULL
        AND e."deletedAt" IS NULL
        AND ma."updatedAt" >= NOW() - (INTERVAL '1 day' * ${days})
    `);
    const [row] = rows;
    return {
      averageSeconds: row?.avg_seconds ?? null,
      p95Seconds: row?.p95_seconds ?? null,
    };
  }
}
