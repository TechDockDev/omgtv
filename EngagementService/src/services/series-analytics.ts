import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";
import { formatHoursMinutes } from "../utils/date-range";

export interface SeriesAnalyticsRow {
  seriesId: string;
  seriesName: string;
  totalEpisodes: number;
  totalWatchSeconds: number;
  totalWatchHours: string;
  totalEpisodeViews: number;
  totalCompletions: number;
  completionPct: number;
  avgWatchHrsPerEpisode: string;
  likes: number;
  saves: number;
  pageViews: number;
  avgRating: number;
  totalReviews: number;
}

interface AnalyticsBaseSeries {
  id: string;
  title: string;
  totalEpisodes: number;
  episodeIds: string[];
}

async function fetchSeriesBase(): Promise<AnalyticsBaseSeries[]> {
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
  const series = raw.data?.series ?? raw.series;
  if (!series) {
    throw new Error("ContentService analytics-base response missing series array");
  }
  return series;
}

export async function getSeriesAnalyticsReport(params: {
  prisma: PrismaClient;
  start: Date;
  end: Date;
}): Promise<SeriesAnalyticsRow[]> {
  const { prisma, start, end } = params;
  const series = await fetchSeriesBase();
  if (series.length === 0) return [];

  const episodeToSeries = new Map<string, string>();
  const allEpisodeIds: string[] = [];
  const seriesIds = series.map((s) => s.id);

  for (const s of series) {
    for (const epId of s.episodeIds) {
      episodeToSeries.set(epId, s.id);
      allEpisodeIds.push(epId);
    }
  }

  const [watchAgg, completionAgg, actionAgg, statsRows, reviewAgg] = await Promise.all([
    allEpisodeIds.length
      ? prisma.viewProgress.groupBy({
          by: ["episodeId"],
          where: { episodeId: { in: allEpisodeIds }, updatedAt: { gte: start, lt: end } },
          _sum: { progressSeconds: true },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ episodeId: string; _sum: { progressSeconds: number | null }; _count: { _all: number } }>),
    allEpisodeIds.length
      ? prisma.viewProgress.groupBy({
          by: ["episodeId"],
          where: { episodeId: { in: allEpisodeIds }, completedAt: { gte: start, lt: end } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ episodeId: string; _count: { _all: number } }>),
    prisma.userAction.groupBy({
      by: ["contentId", "actionType"],
      where: {
        contentType: "SERIES",
        contentId: { in: seriesIds },
        isActive: true,
        createdAt: { gte: start, lt: end },
      },
      _count: { _all: true },
    }),
    prisma.contentStats.findMany({
      where: { contentType: "SERIES", contentId: { in: seriesIds } },
      select: { contentId: true, viewCount: true },
    }),
    prisma.review.groupBy({
      by: ["contentId"],
      where: {
        contentType: "SERIES",
        contentId: { in: seriesIds },
        createdAt: { gte: start, lt: end },
      },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  const watchBySeries = new Map<string, { seconds: number; views: number }>();
  for (const row of watchAgg) {
    const seriesId = episodeToSeries.get(row.episodeId);
    if (!seriesId) continue;
    const cur = watchBySeries.get(seriesId) ?? { seconds: 0, views: 0 };
    cur.seconds += row._sum.progressSeconds ?? 0;
    cur.views += row._count._all;
    watchBySeries.set(seriesId, cur);
  }

  const completionsBySeries = new Map<string, number>();
  for (const row of completionAgg) {
    const seriesId = episodeToSeries.get(row.episodeId);
    if (!seriesId) continue;
    completionsBySeries.set(seriesId, (completionsBySeries.get(seriesId) ?? 0) + row._count._all);
  }

  const likesBySeries = new Map<string, number>();
  const savesBySeries = new Map<string, number>();
  for (const row of actionAgg) {
    if (row.actionType === "LIKE") likesBySeries.set(row.contentId, row._count._all);
    if (row.actionType === "SAVE") savesBySeries.set(row.contentId, row._count._all);
  }

  const pageViewsBySeries = new Map<string, number>();
  for (const row of statsRows) {
    pageViewsBySeries.set(row.contentId, row.viewCount);
  }

  const ratingBySeries = new Map<string, { avg: number; count: number }>();
  for (const row of reviewAgg) {
    ratingBySeries.set(row.contentId, { avg: row._avg.rating ?? 0, count: row._count._all });
  }

  const rows: SeriesAnalyticsRow[] = series.map((s) => {
    const watch = watchBySeries.get(s.id) ?? { seconds: 0, views: 0 };
    const completions = completionsBySeries.get(s.id) ?? 0;
    const rating = ratingBySeries.get(s.id) ?? { avg: 0, count: 0 };

    return {
      seriesId: s.id,
      seriesName: s.title,
      totalEpisodes: s.totalEpisodes,
      totalWatchSeconds: watch.seconds,
      totalWatchHours: formatHoursMinutes(watch.seconds),
      totalEpisodeViews: watch.views,
      totalCompletions: completions,
      completionPct: watch.views > 0 ? Math.round((completions / watch.views) * 1000) / 10 : 0,
      avgWatchHrsPerEpisode: formatHoursMinutes(s.totalEpisodes > 0 ? watch.seconds / s.totalEpisodes : 0),
      likes: likesBySeries.get(s.id) ?? 0,
      saves: savesBySeries.get(s.id) ?? 0,
      pageViews: pageViewsBySeries.get(s.id) ?? 0,
      avgRating: Math.round(rating.avg * 10) / 10,
      totalReviews: rating.count,
    };
  });

  rows.sort((a, b) => b.totalWatchSeconds - a.totalWatchSeconds);
  return rows;
}

export function seriesAnalyticsToCsv(rows: SeriesAnalyticsRow[]): string {
  const headers = [
    "Series ID", "Series Name", "Total Episodes", "Total Watch Hours",
    "Total Episode Views", "Total Completions", "Completion %",
    "Avg Watch Hrs Per Episode", "Likes", "Saves", "Page Views",
    "Avg Rating", "Total Reviews",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.seriesId,
        `"${r.seriesName.replace(/"/g, '""')}"`,
        r.totalEpisodes,
        r.totalWatchHours,
        r.totalEpisodeViews,
        r.totalCompletions,
        `${r.completionPct.toFixed(1)}%`,
        r.avgWatchHrsPerEpisode,
        r.likes,
        r.saves,
        r.pageViews,
        r.avgRating,
        r.totalReviews,
      ].join(",")
    );
  }
  return lines.join("\n");
}
