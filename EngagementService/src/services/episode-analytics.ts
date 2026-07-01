import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";

export interface EpisodeMeta {
  id: string;
  title: string;
  episodeNumber: number | null;
  displayOrder: number | null;
  durationSeconds: number;
}

export interface EpisodeAnalyticsRow {
  episodeId: string;
  episodeNumber: number | null;
  displayOrder: number | null;
  title: string;
  durationSeconds: number;
  unique_wp_starts: number;
  completions: number;
  completionPct: number;
  avgWatchMin: number;
  skipExitPct: number;
}

export interface SeriesMeta {
  id: string;
  title: string;
}

async function fetchEpisodesForSeries(seriesId: string): Promise<{
  series: SeriesMeta | null;
  episodes: EpisodeMeta[];
}> {
  const config = loadConfig();
  const res = await fetch(
    `${config.CONTENT_SERVICE_URL}/internal/series/${seriesId}/episodes-for-analytics`,
    { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }
  );
  if (!res.ok) {
    throw new Error(`ContentService episodes-for-analytics failed: ${res.status}`);
  }
  const raw = (await res.json()) as { data?: { series: SeriesMeta | null; episodes: EpisodeMeta[] }; series?: SeriesMeta | null; episodes?: EpisodeMeta[] };
  const series = raw.data?.series ?? raw.series ?? null;
  const episodes = raw.data?.episodes ?? raw.episodes ?? [];
  return { series, episodes };
}

export async function getEpisodeAnalytics(params: {
  prisma: PrismaClient;
  seriesId: string;
  start: Date | null;
  end: Date | null;
}): Promise<{ series: SeriesMeta | null; episodes: EpisodeAnalyticsRow[] }> {
  const { prisma, seriesId, start, end } = params;

  const { series, episodes } = await fetchEpisodesForSeries(seriesId);
  if (episodes.length === 0) return { series, episodes: [] };

  const episodeIds = episodes.map((e) => e.id);

  // Date filter on updatedAt — when the user last interacted with the episode.
  // Null start/end = all-time.
  const dateFilter = start && end ? { updatedAt: { gte: start, lt: end } } : {};

  const [startAgg, completionAgg, avgAgg] = await Promise.all([
    // unique_wp_starts: count of ViewProgress rows per episode (one row = one unique user who started)
    prisma.viewProgress.groupBy({
      by: ["episodeId"],
      where: { episodeId: { in: episodeIds }, ...dateFilter },
      _count: { _all: true },
    }),

    // completions: rows where completedAt is not null (95% threshold already enforced on write)
    prisma.viewProgress.groupBy({
      by: ["episodeId"],
      where: {
        episodeId: { in: episodeIds },
        completedAt: { not: null },
        ...dateFilter,
      },
      _count: { _all: true },
    }),

    // avgWatchMin: AVG(progressSeconds) per episode = average max depth reached per user
    prisma.viewProgress.groupBy({
      by: ["episodeId"],
      where: { episodeId: { in: episodeIds }, ...dateFilter },
      _avg: { progressSeconds: true },
    }),
  ]);

  const startsMap = new Map(startAgg.map((r) => [r.episodeId, r._count._all]));
  const completionsMap = new Map(completionAgg.map((r) => [r.episodeId, r._count._all]));
  const avgMap = new Map(avgAgg.map((r) => [r.episodeId, r._avg.progressSeconds ?? 0]));

  const rows: EpisodeAnalyticsRow[] = episodes.map((ep) => {
    const starts = startsMap.get(ep.id) ?? 0;
    const comps = completionsMap.get(ep.id) ?? 0;
    const avgSec = avgMap.get(ep.id) ?? 0;

    return {
      episodeId: ep.id,
      episodeNumber: ep.episodeNumber,
      displayOrder: ep.displayOrder,
      title: ep.title,
      durationSeconds: ep.durationSeconds,
      unique_wp_starts: starts,
      completions: comps,
      completionPct: starts > 0 ? Math.round((comps / starts) * 1000) / 10 : 0,
      avgWatchMin: Math.round((avgSec / 60) * 10) / 10,
      skipExitPct: starts > 0 ? Math.round(((starts - comps) / starts) * 1000) / 10 : 0,
    };
  });

  return { series, episodes: rows };
}
