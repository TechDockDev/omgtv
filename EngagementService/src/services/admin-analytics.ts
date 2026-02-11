import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";

const config = loadConfig();

export interface UserContentStats {
    watchHistory: Array<{
        episodeId: string;
        title: string;
        thumbnailUrl: string | null;
        manifestUrl: string | null;
        progressSeconds: number;
        durationSeconds: number;
        isCompleted: boolean;
        lastWatchedAt: string;
    }>;
    likes: {
        reels: any[];
        series: any[];
    };
    saves: {
        reels: any[];
        series: any[];
    };
    ongoingSeries: any[];
    completedSeries: any[];
    stats: {
        totalWatchTimeSeconds: number;
        episodesStarted: number;
        episodesCompleted: number;
        totalLikes: number;
        totalSaves: number;
    };
}

export async function getUserContentStats(params: {
    prisma: PrismaClient;
    userId: string;
}): Promise<UserContentStats> {
    const { prisma, userId } = params;

    const [watchHistory, likedActions, savedActions] = await Promise.all([
        prisma.viewProgress.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: 100,
        }),
        prisma.userAction.findMany({
            where: { userId, actionType: "LIKE", isActive: true },
            select: { contentType: true, contentId: true },
        }),
        prisma.userAction.findMany({
            where: { userId, actionType: "SAVE", isActive: true },
            select: { contentType: true, contentId: true },
        }),
    ]);

    const likedReelIds = likedActions.filter(a => a.contentType === "REEL").map(a => a.contentId);
    const likedSeriesIds = likedActions.filter(a => a.contentType === "SERIES").map(a => a.contentId);
    const savedReelIds = savedActions.filter(a => a.contentType === "REEL").map(a => a.contentId);
    const savedSeriesIds = savedActions.filter(a => a.contentType === "SERIES").map(a => a.contentId);
    const episodeIds = watchHistory.map(h => h.episodeId);

    const fetchMetadata = async (ids: string[], type: "reel" | "series" | "episode") => {
        if (ids.length === 0) return [];
        const res = await fetch(`${config.CONTENT_SERVICE_URL}/internal/catalog/batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-service-token": config.SERVICE_AUTH_TOKEN || "" },
            body: JSON.stringify({ ids, type })
        }).then(res => res.json()).catch(() => ({ items: [] }));
        return res.items || [];
    };

    const [
        episodeMeta,
        likedReelsMeta,
        likedSeriesMeta,
        savedReelsMeta,
        savedSeriesMeta
    ] = await Promise.all([
        fetchMetadata(episodeIds, "episode"),
        fetchMetadata(likedReelIds, "reel"),
        fetchMetadata(likedSeriesIds, "series"),
        fetchMetadata(savedReelIds, "reel"),
        fetchMetadata(savedSeriesIds, "series")
    ]);

    const mapContent = (ids: string[], items: any[], type: string) => {
        return ids.map(id => {
            const meta = items.find(i => i.id === id);
            return {
                id,
                title: meta?.title || "Unknown Content",
                thumbnailUrl: meta?.thumbnailUrl || meta?.posterUrl || meta?.heroImageUrl || meta?.defaultThumbnailUrl || null,
                manifestUrl: meta?.playback?.manifestUrl || null,
            };
        });
    };

    const totalWatchTimeSeconds = watchHistory.reduce((sum, entry) => sum + entry.progressSeconds, 0);
    const episodesCompleted = watchHistory.filter(entry => entry.completedAt !== null).length;

    // Calculate Series Completion
    const seriesMap = new Map<string, { completedEpisodes: Set<string>; allWatchedEpisodes: Set<string> }>();
    watchHistory.forEach(h => {
        const meta = episodeMeta.find((m: any) => m.id === h.episodeId);
        if (meta && meta.seriesId) {
            if (!seriesMap.has(meta.seriesId)) {
                seriesMap.set(meta.seriesId, { completedEpisodes: new Set(), allWatchedEpisodes: new Set() });
            }
            const data = seriesMap.get(meta.seriesId)!;
            data.allWatchedEpisodes.add(h.episodeId);
            if (h.completedAt) data.completedEpisodes.add(h.episodeId);
        }
    });

    const uniqueSeriesIds = Array.from(seriesMap.keys());
    const seriesMetaForCompletion = await fetchMetadata(uniqueSeriesIds, "series");

    const ongoingSeries: any[] = [];
    const completedSeries: any[] = [];

    seriesMetaForCompletion.forEach((meta: any) => {
        const userData = seriesMap.get(meta.id);
        if (userData) {
            const seriesInfo = {
                id: meta.id,
                title: meta.title,
                thumbnailUrl: meta.thumbnailUrl,
                totalEpisodes: meta.totalEpisodes || 0,
                userCompletedEpisodes: userData.completedEpisodes.size,
                progressPercentage: meta.totalEpisodes > 0
                    ? Math.round((userData.completedEpisodes.size / meta.totalEpisodes) * 100)
                    : 0
            };

            if (userData.completedEpisodes.size === meta.totalEpisodes && meta.totalEpisodes > 0) {
                completedSeries.push(seriesInfo);
            } else {
                ongoingSeries.push(seriesInfo);
            }
        }
    });

    return {
        watchHistory: watchHistory.map(entry => {
            const meta = episodeMeta.find((m: any) => m.id === entry.episodeId);
            return {
                episodeId: entry.episodeId,
                title: meta?.title || "Unknown Episode",
                thumbnailUrl: meta?.defaultThumbnailUrl || meta?.heroImageUrl || null,
                manifestUrl: meta?.playback?.manifestUrl || null,
                progressSeconds: entry.progressSeconds,
                durationSeconds: entry.durationSeconds,
                isCompleted: entry.completedAt !== null,
                lastWatchedAt: entry.updatedAt.toISOString(),
            };
        }),
        likes: {
            reels: mapContent(likedReelIds, likedReelsMeta, "reel"),
            series: mapContent(likedSeriesIds, likedSeriesMeta, "series"),
        },
        saves: {
            reels: mapContent(savedReelIds, savedReelsMeta, "reel"),
            series: mapContent(savedSeriesIds, savedSeriesMeta, "series"),
        },
        ongoingSeries,
        completedSeries,
        stats: {
            totalWatchTimeSeconds,
            episodesStarted: watchHistory.length,
            episodesCompleted,
            totalLikes: likedActions.length,
            totalSaves: savedActions.length,
        },
    };
}

export interface MetricWithTrend {
    value: number;
    percentageChange: number; // e.g. 5.2 for +5.2%
}

export interface GeneralDashboardStats {
    overview: {
        dau: MetricWithTrend;
        newUsers: MetricWithTrend;
        totalRevenue: MetricWithTrend;
        totalSubscribers: MetricWithTrend;
        totalLogin: MetricWithTrend;
        totalLogout: MetricWithTrend;
        totalUninstall: MetricWithTrend;
    };
    contentPerformance: {
        topSeries: any[];
        topReels: any[];
    };
    topScreens: Array<{ name: string; viewCount: number }>;
    revenueTrend: Array<{ date: string; value: number }>;
    userGrowthTrend: Array<{ date: string; value: number }>;
}

async function getPeriodStats(prisma: PrismaClient, start: Date, end: Date, granularity: "daily" | "monthly" | "yearly") {
    const revUrl = `${config.SUBSCRIPTION_SERVICE_URL}/internal/revenue/stats?startDate=${start.toISOString()}&endDate=${end.toISOString()}&granularity=${granularity}`;
    const userUrl = `${config.USER_SERVICE_URL}/internal/stats?startDate=${start.toISOString()}&endDate=${end.toISOString()}&granularity=${granularity}`;

    const [revRes, userRes, dauCount, loginCount, logoutCount, uninstallCount] = await Promise.all([
        fetch(revUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ totalRevenuePaise: 0, trend: [] })),
        fetch(userUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ newCustomers: 0, totalCustomers: 0, trend: [] })),
        (prisma as any).appEvent.groupBy({
            by: ["userId"],
            where: { createdAt: { gte: start, lte: end } },
            _count: true,
        }).then((res: any[]) => res.length),
        (prisma as any).appEvent.count({ where: { eventType: "login", createdAt: { gte: start, lte: end } } }),
        (prisma as any).appEvent.count({ where: { eventType: "logout", createdAt: { gte: start, lte: end } } }),
        (prisma as any).appEvent.count({ where: { eventType: "uninstall", createdAt: { gte: start, lte: end } } }),
    ]);

    return {
        revenue: ((revRes as any).totalRevenuePaise || 0) / 100,
        newUsers: (userRes as any).newCustomers || 0,
        totalSubscribers: (userRes as any).totalCustomers || 0,
        dau: dauCount,
        login: loginCount,
        logout: logoutCount,
        uninstall: uninstallCount,
        revenueTrend: (revRes as any).trend || [],
        userGrowthTrend: (userRes as any).trend || [],
    };
}

function calculateChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Number(((current - previous) / previous * 100).toFixed(2));
}

export async function getGeneralDashboardStats(params: {
    prisma: PrismaClient;
    startDate?: string;
    endDate?: string;
    granularity?: "daily" | "monthly" | "yearly";
}): Promise<GeneralDashboardStats> {
    const { prisma, startDate, endDate, granularity = "daily" } = params;
    const currentEnd = endDate ? new Date(endDate) : new Date();
    let currentStart: Date;
    if (startDate) {
        currentStart = new Date(startDate);
    } else {
        const offset = granularity === "yearly"
            ? 3 * 365 * 24 * 60 * 60 * 1000 // 3 years
            : granularity === "monthly"
                ? 6 * 30 * 24 * 60 * 60 * 1000 // 6 months
                : 30 * 24 * 60 * 60 * 1000;    // 30 days (daily)
        currentStart = new Date(currentEnd.getTime() - offset);
    }

    const duration = currentEnd.getTime() - currentStart.getTime();
    const prevEnd = new Date(currentStart.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - duration);

    const [currentStats, prevStats] = await Promise.all([
        getPeriodStats(prisma, currentStart, currentEnd, granularity),
        getPeriodStats(prisma, prevStart, prevEnd, granularity),
    ]);

    // Content Performance (Current Period)
    const [topSeriesStats, topReelsStats] = await Promise.all([
        prisma.contentStats.findMany({ where: { contentType: "SERIES" }, orderBy: { viewCount: "desc" }, take: 10 }),
        prisma.contentStats.findMany({ where: { contentType: "REEL" }, orderBy: { viewCount: "desc" }, take: 10 }),
    ]);

    const fetchMetadataExtended = async (ids: string[], type: "reel" | "series" | "episode") => {
        if (ids.length === 0) return [];
        const res = await fetch(`${config.CONTENT_SERVICE_URL}/internal/catalog/batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-service-token": config.SERVICE_AUTH_TOKEN || "" },
            body: JSON.stringify({ ids, type })
        }).then(res => res.json()).catch(() => ({ items: [] }));
        return res.items || [];
    };

    const [seriesMetadata, reelsMetadata] = await Promise.all([
        fetchMetadataExtended(topSeriesStats.map(s => s.contentId), "series"),
        fetchMetadataExtended(topReelsStats.map(s => s.contentId), "reel"),
    ]);

    const mapStats = (items: any[], stats: any[]) => {
        return stats.map(s => {
            const meta = items.find(i => i.id === s.contentId);
            return {
                id: s.contentId,
                title: meta?.title || "Unknown Content",
                thumbnailUrl: meta?.thumbnailUrl || meta?.posterUrl || null,
                stats: { viewCount: s.viewCount, likeCount: s.likeCount, saveCount: s.saveCount }
            };
        });
    };

    // Top Screens
    const screens = await (prisma as any).appEvent.findMany({
        where: {
            eventType: "screen_view",
            createdAt: { gte: currentStart, lte: currentEnd }
        }
    });

    const screenCounts: Record<string, number> = {};
    screens.forEach((s: any) => {
        const screenName = (s.eventData as any)?.screen || "unknown";
        screenCounts[screenName] = (screenCounts[screenName] || 0) + 1;
    });

    const topScreens = Object.entries(screenCounts)
        .map(([name, viewCount]) => ({ name, viewCount }))
        .sort((a, b) => b.viewCount - a.viewCount)
        .slice(0, 10);

    return {
        overview: {
            dau: { value: currentStats.dau, percentageChange: calculateChange(currentStats.dau, prevStats.dau) },
            newUsers: { value: currentStats.newUsers, percentageChange: calculateChange(currentStats.newUsers, prevStats.newUsers) },
            totalRevenue: { value: currentStats.revenue, percentageChange: calculateChange(currentStats.revenue, prevStats.revenue) },
            totalSubscribers: { value: currentStats.totalSubscribers, percentageChange: calculateChange(currentStats.totalSubscribers, prevStats.totalSubscribers) },
            totalLogin: { value: currentStats.login, percentageChange: calculateChange(currentStats.login, prevStats.login) },
            totalLogout: { value: currentStats.logout, percentageChange: calculateChange(currentStats.logout, prevStats.logout) },
            totalUninstall: { value: currentStats.uninstall, percentageChange: calculateChange(currentStats.uninstall, prevStats.uninstall) },
        },
        contentPerformance: {
            topSeries: mapStats(seriesMetadata, topSeriesStats),
            topReels: mapStats(reelsMetadata, topReelsStats),
        },
        topScreens,
        revenueTrend: currentStats.revenueTrend,
        userGrowthTrend: currentStats.userGrowthTrend,
    };
}
