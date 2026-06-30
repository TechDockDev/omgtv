import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";

export interface AudioTrendingRow {
  seriesId: string;
  seriesName: string;
  totalEpisodes: number;
  viewCount: number;
  watchSeconds: number;
}

interface AnalyticsBaseSeries {
  id: string;
  title: string;
  isAudioSeries: boolean;
  totalEpisodes: number;
  episodeIds: string[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_N = 20;

/**
 * Ranks audio series by view activity over the trailing 7 days. Pure read against
 * ViewProgress — no schema change, same groupBy pattern as series-analytics.ts.
 * Admin pin/exclude overrides are applied by ContentService, not here; this returns
 * the raw auto-computed ranking only.
 */
export async function getAudioTrendingThisWeek(params: {
  prisma: PrismaClient;
}): Promise<AudioTrendingRow[]> {
  const { prisma } = params;
  const config = loadConfig();

  const res = await fetch(`${config.CONTENT_SERVICE_URL}/internal/series/analytics-base`, {
    headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" },
  });
  if (!res.ok) {
    throw new Error(`ContentService analytics-base call failed: ${res.status}`);
  }
  // ContentService's global-response.ts onSend hook wraps every JSON response in
  // {success, statusCode, ..., data: {...}} — unwrap it the same way EngagementClient does.
  const raw = (await res.json()) as { data?: { series: AnalyticsBaseSeries[] }; series?: AnalyticsBaseSeries[] };
  const allSeries = raw.data?.series ?? raw.series;
  if (!allSeries) {
    throw new Error("ContentService analytics-base response missing series array");
  }
  const audioSeries = allSeries.filter((s) => s.isAudioSeries);
  if (audioSeries.length === 0) return [];

  const episodeToSeries = new Map<string, string>();
  const allEpisodeIds: string[] = [];
  for (const s of audioSeries) {
    for (const epId of s.episodeIds) {
      episodeToSeries.set(epId, s.id);
      allEpisodeIds.push(epId);
    }
  }
  if (allEpisodeIds.length === 0) return [];

  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  const watchAgg = await prisma.viewProgress.groupBy({
    by: ["episodeId"],
    where: { episodeId: { in: allEpisodeIds }, updatedAt: { gte: sevenDaysAgo } },
    _sum: { progressSeconds: true },
    _count: { _all: true },
  });

  const watchBySeries = new Map<string, { views: number; seconds: number }>();
  for (const row of watchAgg) {
    const seriesId = episodeToSeries.get(row.episodeId);
    if (!seriesId) continue;
    const cur = watchBySeries.get(seriesId) ?? { views: 0, seconds: 0 };
    cur.views += row._count._all;
    cur.seconds += row._sum.progressSeconds ?? 0;
    watchBySeries.set(seriesId, cur);
  }

  const rows: AudioTrendingRow[] = audioSeries
    .map((s) => {
      const watch = watchBySeries.get(s.id) ?? { views: 0, seconds: 0 };
      return {
        seriesId: s.id,
        seriesName: s.title,
        totalEpisodes: s.totalEpisodes,
        viewCount: watch.views,
        watchSeconds: watch.seconds,
      };
    })
    .filter((row) => row.viewCount > 0)
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, TOP_N);

  return rows;
}
