import type { PrismaClient, Series } from "@prisma/client";
import { PublicationStatus, Visibility } from "@prisma/client";
import { CatalogServiceError } from "./catalog-service";
import { EngagementClient } from "../clients/engagement-client";

// Mirrors CatalogService's private ensureCarouselSeriesSelectable/isSeriesPubliclyDiscoverable
// (those are private class methods, not importable) — same gate video Top 10/Carousel use:
// a series must be published, public, and already released before it can be featured.
function ensureAudioSeriesSelectable(series: Series) {
  if (series.status !== PublicationStatus.PUBLISHED) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${series.id} must be published before featuring`);
  }
  if (series.visibility !== Visibility.PUBLIC) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${series.id} must be public before featuring`);
  }
}

function isSeriesPubliclyDiscoverable(
  series: Pick<Series, "status" | "visibility" | "releaseDate">,
  now: Date = new Date()
) {
  return (
    series.status === PublicationStatus.PUBLISHED &&
    series.visibility === Visibility.PUBLIC &&
    (!series.releaseDate || series.releaseDate <= now)
  );
}

const fullSeriesInclude = {
  audioCategory: true as const,
  // Count only active episodes — soft-deleted ones must not inflate totalEpisodes
  _count: { select: { episodes: { where: { deletedAt: null } } } },
} as const;

export interface AudioSeriesSummary {
  id: string;
  slug: string;
  title: string;
  synopsis: string | null;
  heroImageUrl: string | null;
  bannerImageUrl: string | null;
  isFree: boolean;
  totalEpisodes: number;
  totalDurationSeconds: number;
  audioCategory: { id: string; name: string } | null;
}

async function buildSeriesSummaries(prisma: PrismaClient, seriesIds: string[]): Promise<Map<string, AudioSeriesSummary>> {
  if (seriesIds.length === 0) return new Map();

  const [series, episodes] = await Promise.all([
    prisma.series.findMany({
      where: { id: { in: seriesIds }, deletedAt: null },
      include: fullSeriesInclude,
    }),
    prisma.episode.groupBy({
      by: ["seriesId"],
      where: { seriesId: { in: seriesIds }, deletedAt: null },
      _sum: { durationSeconds: true },
      _count: { _all: true },
    }),
  ]);

  const durationBySeriesId = new Map(episodes.map((e) => [e.seriesId, { count: e._count._all, seconds: e._sum.durationSeconds ?? 0 }]));

  const result = new Map<string, AudioSeriesSummary>();
  for (const s of series) {
    const agg = durationBySeriesId.get(s.id) ?? { count: 0, seconds: 0 };
    result.set(s.id, {
      id: s.id,
      slug: s.slug,
      title: s.title,
      synopsis: s.synopsis,
      heroImageUrl: s.heroImageUrl,
      bannerImageUrl: s.bannerImageUrl,
      isFree: s.isFree,
      totalEpisodes: agg.count,
      totalDurationSeconds: agg.seconds,
      audioCategory: s.audioCategory ? { id: s.audioCategory.id, name: s.audioCategory.name } : null,
    });
  }
  return result;
}

// ---------------- Carousel ----------------

export interface AudioCarouselEntryView {
  id: string;
  position: number;
  series: AudioSeriesSummary | null;
}

export async function listAudioCarousel(prisma: PrismaClient): Promise<AudioCarouselEntryView[]> {
  const entries = await prisma.audioCarouselEntry.findMany({ orderBy: { position: "asc" } });
  const summaries = await buildSeriesSummaries(prisma, entries.map((e) => e.seriesId));
  // Drop entries whose series was since soft-deleted — buildSeriesSummaries won't resolve
  // them, and a ghost "series: null" row is never useful to a caller.
  return entries
    .map((e) => ({ id: e.id, position: e.position, series: summaries.get(e.seriesId) ?? null }))
    .filter((e) => e.series !== null);
}

export async function setAudioCarousel(
  prisma: PrismaClient,
  adminId: string,
  items: Array<{ seriesId: string }>
) {
  if (items.length === 0) {
    throw new CatalogServiceError("FAILED_PRECONDITION", "At least one carousel entry is required");
  }
  if (items.length > 50) {
    throw new CatalogServiceError("FAILED_PRECONDITION", "Audio carousel is limited to 50 entries");
  }

  const seriesIds = Array.from(new Set(items.map((i) => i.seriesId)));
  const series = await prisma.series.findMany({ where: { id: { in: seriesIds }, deletedAt: null } });
  const seriesById = new Map(series.map((s) => [s.id, s]));

  for (const item of items) {
    const record = seriesById.get(item.seriesId);
    if (!record) {
      throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${item.seriesId} is unavailable`);
    }
    if (!record.isAudioSeries) {
      throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${item.seriesId} is not an audio series`);
    }
    ensureAudioSeriesSelectable(record);
  }

  await prisma.$transaction(async (tx) => {
    await tx.audioCarouselEntry.deleteMany({});
    await tx.audioCarouselEntry.createMany({
      data: items.map((item, index) => ({
        position: index + 1,
        seriesId: item.seriesId,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      })),
    });
  });

  return listAudioCarousel(prisma);
}

export async function addAudioCarouselSeries(prisma: PrismaClient, adminId: string, seriesId: string) {
  const series = await prisma.series.findFirst({ where: { id: seriesId, deletedAt: null } });
  if (!series) throw new CatalogServiceError("NOT_FOUND", "Series not found");
  if (!series.isAudioSeries) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${seriesId} is not an audio series`);
  }
  ensureAudioSeriesSelectable(series);

  const existing = await prisma.audioCarouselEntry.findFirst({ where: { seriesId } });
  if (existing) return existing;

  const maxPosition = await prisma.audioCarouselEntry.aggregate({ _max: { position: true } });
  return prisma.audioCarouselEntry.create({
    data: {
      seriesId,
      position: (maxPosition._max.position ?? 0) + 1,
      createdByAdminId: adminId,
      updatedByAdminId: adminId,
    },
  });
}

export async function removeAudioCarouselSeries(prisma: PrismaClient, seriesId: string) {
  return prisma.audioCarouselEntry.deleteMany({ where: { seriesId } });
}

// ---------------- Top 10 ----------------

export interface AudioTopTenEntryView {
  position: number;
  series: AudioSeriesSummary | null;
}

export async function getAdminAudioTopTen(prisma: PrismaClient): Promise<AudioTopTenEntryView[]> {
  const entries = await prisma.audioTopTenSeries.findMany({ orderBy: { position: "asc" } });
  const summaries = await buildSeriesSummaries(prisma, entries.map((e) => e.seriesId));
  // Drop entries whose series was since soft-deleted (see listAudioCarousel for why).
  return entries
    .map((e) => ({ position: e.position, series: summaries.get(e.seriesId) ?? null }))
    .filter((e) => e.series !== null);
}

/** Mobile-facing — only entries whose series is still published/public/released. */
export async function getPublicAudioTopTen(prisma: PrismaClient, now: Date = new Date()): Promise<AudioTopTenEntryView[]> {
  const entries = await prisma.audioTopTenSeries.findMany({
    where: {
      series: {
        deletedAt: null,
        status: PublicationStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        OR: [{ releaseDate: null }, { releaseDate: { lte: now } }],
      },
    },
    orderBy: { position: "asc" },
  });
  const summaries = await buildSeriesSummaries(prisma, entries.map((e) => e.seriesId));
  return entries.map((e) => ({ position: e.position, series: summaries.get(e.seriesId) ?? null }));
}

export async function updateAudioTopTen(
  prisma: PrismaClient,
  items: Array<{ seriesId: string; position: number }>
) {
  if (items.length > 10) {
    throw new CatalogServiceError("FAILED_PRECONDITION", "Cannot have more than 10 series in the Audio Top 10 list");
  }

  const duplicateSeriesIds = items.map((i) => i.seriesId).filter((id, idx, all) => all.indexOf(id) !== idx);
  if (duplicateSeriesIds.length > 0) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Duplicate series IDs are not allowed: ${Array.from(new Set(duplicateSeriesIds)).join(", ")}`);
  }
  const duplicatePositions = items.map((i) => i.position).filter((p, idx, all) => all.indexOf(p) !== idx);
  if (duplicatePositions.length > 0) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Duplicate Top 10 positions are not allowed: ${Array.from(new Set(duplicatePositions)).join(", ")}`);
  }

  const normalized = [...items].sort((a, b) => a.position - b.position).map((item, index) => ({ seriesId: item.seriesId, position: index + 1 }));

  const seriesIds = normalized.map((i) => i.seriesId);
  const found = await prisma.series.findMany({ where: { id: { in: seriesIds }, deletedAt: null } });
  if (found.length !== seriesIds.length) {
    const foundIds = new Set(found.map((s) => s.id));
    const missing = seriesIds.filter((id) => !foundIds.has(id));
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series IDs not found: ${missing.join(", ")}`);
  }
  const notAudio = found.filter((s) => !s.isAudioSeries);
  if (notAudio.length > 0) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series are not audio series: ${notAudio.map((s) => s.id).join(", ")}`);
  }
  const invalid = found.filter((s) => !isSeriesPubliclyDiscoverable(s));
  if (invalid.length > 0) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series must be published, public, and already released before entering Audio Top 10: ${invalid.map((s) => s.id).join(", ")}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.audioTopTenSeries.deleteMany({});
    if (normalized.length > 0) {
      await tx.audioTopTenSeries.createMany({ data: normalized });
    }
  });

  return getAdminAudioTopTen(prisma);
}

// ---------------- Categories ----------------

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function createAudioCategory(
  prisma: PrismaClient,
  adminId: string,
  input: { name: string; description?: string; displayOrder?: number }
) {
  const baseSlug = slugify(input.name);
  let slug = baseSlug;
  let suffix = 1;
  while (await prisma.audioCategory.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${++suffix}`;
  }

  return prisma.audioCategory.create({
    data: {
      slug,
      name: input.name,
      description: input.description ?? null,
      displayOrder: input.displayOrder ?? null,
      createdByAdminId: adminId,
      updatedByAdminId: adminId,
    },
  });
}

export async function listAudioCategories(prisma: PrismaClient, params: { limit: number; cursor?: string }) {
  const rows = await prisma.audioCategory.findMany({
    where: { deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
}

export async function getAudioCategory(prisma: PrismaClient, id: string) {
  return prisma.audioCategory.findFirst({ where: { id, deletedAt: null } });
}

export async function updateAudioCategory(
  prisma: PrismaClient,
  adminId: string,
  id: string,
  input: { name?: string; description?: string; displayOrder?: number }
) {
  const existing = await prisma.audioCategory.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new CatalogServiceError("NOT_FOUND", "Audio category not found");

  return prisma.audioCategory.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      displayOrder: input.displayOrder ?? undefined,
      updatedByAdminId: adminId,
    },
  });
}

export async function deleteAudioCategory(prisma: PrismaClient, id: string) {
  const existing = await prisma.audioCategory.findFirst({ where: { id } });
  if (!existing) throw new CatalogServiceError("NOT_FOUND", "Audio category not found");
  if (existing.deletedAt) return { alreadyDeleted: true as const };

  await prisma.audioCategory.update({ where: { id }, data: { deletedAt: new Date() } });
  return { alreadyDeleted: false as const };
}

export async function mapSeriesToAudioCategory(prisma: PrismaClient, categoryId: string, seriesId: string) {
  const category = await prisma.audioCategory.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) throw new CatalogServiceError("NOT_FOUND", "Audio category not found");

  const series = await prisma.series.findFirst({ where: { id: seriesId, deletedAt: null } });
  if (!series) throw new CatalogServiceError("NOT_FOUND", "Series not found");
  if (!series.isAudioSeries) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${seriesId} is not an audio series`);
  }

  return prisma.series.update({ where: { id: seriesId }, data: { audioCategoryId: categoryId } });
}

export async function unmapSeriesFromAudioCategory(prisma: PrismaClient, categoryId: string, seriesId: string) {
  return prisma.series.updateMany({
    where: { id: seriesId, audioCategoryId: categoryId },
    data: { audioCategoryId: null },
  });
}

// ---------------- Trending This Week ----------------

export interface AudioTrendingItem {
  series: AudioSeriesSummary | null;
  seriesId: string;
  viewCount: number;
  watchSeconds: number;
  source: "auto" | "pinned";
}

export async function getMergedAudioTrending(
  prisma: PrismaClient,
  engagementClient: EngagementClient
): Promise<AudioTrendingItem[]> {
  const [autoRanked, overrides] = await Promise.all([
    engagementClient.getAudioTrending(),
    prisma.audioTrendingOverride.findMany(),
  ]);

  const excludedIds = new Set(overrides.filter((o) => o.mode === "EXCLUDED").map((o) => o.seriesId));
  const pinned = overrides
    .filter((o) => o.mode === "PINNED" && o.pinnedPosition != null)
    .sort((a, b) => (a.pinnedPosition ?? 0) - (b.pinnedPosition ?? 0));
  const pinnedIds = new Set(pinned.map((o) => o.seriesId));

  const autoFiltered = autoRanked.filter((r) => !excludedIds.has(r.seriesId) && !pinnedIds.has(r.seriesId));

  type Slot = { seriesId: string; viewCount: number; watchSeconds: number; source: "auto" | "pinned" };
  const slots: Slot[] = new Array(10).fill(null);

  for (const p of pinned) {
    const pos = (p.pinnedPosition ?? 1) - 1;
    if (pos >= 0 && pos < 10) {
      const auto = autoRanked.find((r) => r.seriesId === p.seriesId);
      slots[pos] = { seriesId: p.seriesId, viewCount: auto?.viewCount ?? 0, watchSeconds: auto?.watchSeconds ?? 0, source: "pinned" };
    }
  }

  let autoIdx = 0;
  for (let i = 0; i < 10; i++) {
    if (slots[i]) continue;
    while (autoIdx < autoFiltered.length && slots.some((s) => s?.seriesId === autoFiltered[autoIdx].seriesId)) {
      autoIdx++;
    }
    if (autoIdx >= autoFiltered.length) continue;
    const r = autoFiltered[autoIdx++];
    slots[i] = { seriesId: r.seriesId, viewCount: r.viewCount, watchSeconds: r.watchSeconds, source: "auto" };
  }

  const finalSlots = slots.filter((s): s is Slot => Boolean(s));
  const summaries = await buildSeriesSummaries(prisma, finalSlots.map((s) => s.seriesId));

  // Drop slots whose series was since soft-deleted (see listAudioCarousel for why) —
  // most likely a stale pin/exclude override left behind after the series was removed.
  return finalSlots
    .map((s) => ({
      series: summaries.get(s.seriesId) ?? null,
      seriesId: s.seriesId,
      viewCount: s.viewCount,
      watchSeconds: s.watchSeconds,
      source: s.source,
    }))
    .filter((s) => s.series !== null);
}

export async function setAudioTrendingOverride(
  prisma: PrismaClient,
  adminId: string,
  input: { seriesId: string; mode: "PINNED" | "EXCLUDED"; pinnedPosition?: number }
) {
  const series = await prisma.series.findFirst({ where: { id: input.seriesId, deletedAt: null } });
  if (!series) throw new CatalogServiceError("NOT_FOUND", "Series not found");
  if (!series.isAudioSeries) {
    throw new CatalogServiceError("FAILED_PRECONDITION", `Series ${input.seriesId} is not an audio series`);
  }
  if (input.mode === "PINNED" && (!input.pinnedPosition || input.pinnedPosition < 1 || input.pinnedPosition > 10)) {
    throw new CatalogServiceError("FAILED_PRECONDITION", "pinnedPosition must be between 1 and 10 when mode is PINNED");
  }
  if (input.mode === "PINNED") {
    const conflict = await prisma.audioTrendingOverride.findFirst({
      where: { mode: "PINNED", pinnedPosition: input.pinnedPosition, seriesId: { not: input.seriesId } },
    });
    if (conflict) {
      throw new CatalogServiceError(
        "FAILED_PRECONDITION",
        `Position ${input.pinnedPosition} is already pinned to series ${conflict.seriesId}. Unpin it first.`
      );
    }
  }

  return prisma.audioTrendingOverride.upsert({
    where: { seriesId: input.seriesId },
    create: {
      seriesId: input.seriesId,
      mode: input.mode,
      pinnedPosition: input.mode === "PINNED" ? input.pinnedPosition : null,
      createdByAdminId: adminId,
      updatedByAdminId: adminId,
    },
    update: {
      mode: input.mode,
      pinnedPosition: input.mode === "PINNED" ? input.pinnedPosition : null,
      updatedByAdminId: adminId,
    },
  });
}

export async function removeAudioTrendingOverride(prisma: PrismaClient, seriesId: string) {
  return prisma.audioTrendingOverride.deleteMany({ where: { seriesId } });
}

// ---------------- Mobile aggregation helper ----------------

export interface AudioCategorySection {
  id: string;
  name: string;
  displayOrder: number | null;
  series: AudioSeriesSummary[];
}

/** Publicly-discoverable audio series grouped by category, for the audio-home mobile feed. */
export async function getPublicAudioCategorySections(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<AudioCategorySection[]> {
  const categories = await prisma.audioCategory.findMany({
    where: { deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  if (categories.length === 0) return [];

  const series = await prisma.series.findMany({
    where: {
      isAudioSeries: true,
      deletedAt: null,
      status: PublicationStatus.PUBLISHED,
      visibility: Visibility.PUBLIC,
      audioCategoryId: { in: categories.map((c) => c.id) },
      OR: [{ releaseDate: null }, { releaseDate: { lte: now } }],
    },
    include: { _count: { select: { episodes: true } } },
  });

  const episodeAgg = await prisma.episode.groupBy({
    by: ["seriesId"],
    where: { seriesId: { in: series.map((s) => s.id) }, deletedAt: null },
    _sum: { durationSeconds: true },
  });
  const durationBySeriesId = new Map(episodeAgg.map((e) => [e.seriesId, e._sum.durationSeconds ?? 0]));

  const seriesByCategory = new Map<string, AudioSeriesSummary[]>();
  for (const s of series) {
    if (!s.audioCategoryId) continue;
    const list = seriesByCategory.get(s.audioCategoryId) ?? [];
    list.push({
      id: s.id,
      slug: s.slug,
      title: s.title,
      synopsis: s.synopsis,
      heroImageUrl: s.heroImageUrl,
      bannerImageUrl: s.bannerImageUrl,
      isFree: s.isFree,
      totalEpisodes: s._count.episodes,
      totalDurationSeconds: durationBySeriesId.get(s.id) ?? 0,
      audioCategory: null,
    });
    seriesByCategory.set(s.audioCategoryId, list);
  }

  return categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      displayOrder: c.displayOrder,
      series: seriesByCategory.get(c.id) ?? [],
    }))
    .filter((c) => c.series.length > 0);
}

export { buildSeriesSummaries };
