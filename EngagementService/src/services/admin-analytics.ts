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
    pagination: {
        limit: number;
        offset: number;
        totalHistory: number;
        totalLikes: number;
        totalSaves: number;
    };
}

export async function getUserContentStats(params: {
    prisma: PrismaClient;
    userId: string;
    limit?: number;
    offset?: number;
}): Promise<UserContentStats> {
    const { prisma, userId, limit = 50, offset = 0 } = params;

    const [watchHistory, totalWatchHistoryCount, likedActions, totalLikesCount, savedActions, totalSavesCount] = await Promise.all([
        prisma.viewProgress.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: limit,
            skip: offset,
        }),
        prisma.viewProgress.count({ where: { userId } }),
        prisma.userAction.findMany({
            where: { userId, actionType: "LIKE", isActive: true },
            select: { contentType: true, contentId: true },
            take: limit,
            skip: offset,
        }),
        prisma.userAction.count({ where: { userId, actionType: "LIKE", isActive: true } }),
        prisma.userAction.findMany({
            where: { userId, actionType: "SAVE", isActive: true },
            select: { contentType: true, contentId: true },
            take: limit,
            skip: offset,
        }),
        prisma.userAction.count({ where: { userId, actionType: "SAVE", isActive: true } }),
    ]);

    const likedReelIds = likedActions.filter(a => a.contentType === "REEL").map(a => a.contentId);
    const likedSeriesIds = likedActions.filter(a => a.contentType === "SERIES").map(a => a.contentId);
    const savedReelIds = savedActions.filter(a => a.contentType === "REEL").map(a => a.contentId);
    const savedSeriesIds = savedActions.filter(a => a.contentType === "SERIES").map(a => a.contentId);
    const episodeIds = watchHistory.map(h => h.episodeId);

    const fetchMetadata = async (ids: string[], type: "reel" | "series" | "episode") => {
        if (ids.length === 0) return [];
        try {
            const res = await fetch(`${config.CONTENT_SERVICE_URL}/internal/catalog/batch`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-service-token": config.SERVICE_AUTH_TOKEN || "" },
                body: JSON.stringify({ ids, type })
            });
            const payload = await res.json();
            // Handle globalResponsePlugin wrapper: { data: { items: [] } }
            // OR direct response: { items: [] }
            return payload.data?.items || payload.items || [];
        } catch (error) {
            console.error(`Failed to fetch metadata for ${type}:`, error);
            return [];
        }
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

    const totalWatchTimeSeconds = await prisma.viewProgress.aggregate({
        where: { userId },
        _sum: { progressSeconds: true }
    }).then(res => res._sum.progressSeconds || 0);

    const episodesCompleted = await prisma.viewProgress.count({
        where: { userId, completedAt: { not: null } }
    });

    // Calculate Series Completion (Note: this logic relies on fetched episodes, so it might be partial if paginated)
    // For full accuracy, we'd need to fetch ALL watch history, which defeats pagination purposes.
    // For now, we will only show series completion based on the *currently fetched* watch history window.
    // Ideally, we should have a separate 'SeriesProgress' table or aggregation query for this.
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
                thumbnailUrl: meta.thumbnailUrl || meta.posterUrl || meta.heroImageUrl || meta.defaultThumbnailUrl || null,
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

    console.log(`[Analytics] Returning stats for user ${userId}, limit: ${limit}, offset: ${offset}`);
    const response = {
        watchHistory: watchHistory.map(entry => {
            const meta = episodeMeta.find((m: any) => m.id === entry.episodeId);
            return {
                episodeId: entry.episodeId,
                title: meta?.title || "Unknown Episode",
                thumbnailUrl: meta?.thumbnailUrl || meta?.posterUrl || meta?.heroImageUrl || meta?.defaultThumbnailUrl || null,
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
            episodesStarted: totalWatchHistoryCount,
            episodesCompleted,
            totalLikes: totalLikesCount,
            totalSaves: totalSavesCount,
        },
        pagination: {
            limit,
            offset,
            totalHistory: totalWatchHistoryCount,
            totalLikes: totalLikesCount,
            totalSaves: totalSavesCount,
        }
    };
    console.log(`[Analytics] Result Keys for user ${userId}:`, Object.keys(response));
    return response;
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

    const [revRes, userRes, dauData, loginCount, logoutCount, uninstallCount] = await Promise.all([
        fetch(revUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ totalRevenuePaise: 0, trend: [] })),
        fetch(userUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ newCustomers: 0, totalCustomers: 0, trend: [] })),
        prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(DISTINCT COALESCE("userId", "guestId", "deviceId")) as count 
            FROM "AppEvent" 
            WHERE "createdAt" >= ${start} AND "createdAt" <= ${end}
        `.catch(() => [{ count: BigInt(0) }]),
        (prisma as any).appEvent.count({ where: { eventType: "login", createdAt: { gte: start, lte: end } } }),
        (prisma as any).appEvent.count({ where: { eventType: "logout", createdAt: { gte: start, lte: end } } }),
        (prisma as any).appEvent.count({ where: { eventType: "uninstall", createdAt: { gte: start, lte: end } } }),
    ]);

    const dau = Number(dauData[0]?.count || 0);

    return {
        revenue: ((revRes as any).totalRevenuePaise || 0) / 100,
        newUsers: (userRes as any).newCustomers || 0,
        totalSubscribers: (userRes as any).totalCustomers || 0,
        dau,
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
        try {
            const res = await fetch(`${config.CONTENT_SERVICE_URL}/internal/catalog/batch`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-service-token": config.SERVICE_AUTH_TOKEN || "" },
                body: JSON.stringify({ ids, type })
            });

            if (!res.ok) {
                const text = await res.text();
                console.error(`Fetch failed for ${type}: ${res.status} ${res.statusText} - Body: ${text}`);
                throw new Error(`Fetch failed: ${res.statusText}`);
            }

            const payload = await res.json();
            // Handle globalResponsePlugin wrapper: { data: { items: [] } }
            // OR direct response: { items: [] }
            const items = payload.data?.items || payload.items || [];
            console.log(`[ContentFetch] Requested ${ids.length} ${type}s, Received ${items.length} items.`);
            if (items.length === 0) {
                console.warn(`[ContentFetch] Warning: content service returned 0 items for ids:`, ids);
            }
            return items;
        } catch (error) {
            console.error(`Failed to fetch metadata for ${type}:`, error);
            return [];
        }
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
                thumbnailUrl: meta?.thumbnailUrl || meta?.posterUrl || meta?.heroImageUrl || meta?.defaultThumbnailUrl || null,
                stats: { viewCount: s.viewCount, likeCount: s.likeCount, saveCount: s.saveCount }
            };
        });
    };

    // Top Screens via SQL Aggregation
    const topScreensResult = await prisma.$queryRaw<{ name: string, count: bigint }[]>`
        SELECT 
            COALESCE(("eventData"->>'screen'), 'unknown') as name,
            COUNT(*) as count
        FROM "AppEvent"
        WHERE "eventType" = 'screen_view' 
          AND "createdAt" >= ${currentStart} 
          AND "createdAt" <= ${currentEnd}
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
    `.catch(() => []);

    const topScreens = topScreensResult.map(r => ({
        name: r.name,
        viewCount: Number(r.count)
    }));

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
            topSeries: mapStats(seriesMetadata, topSeriesStats).slice(0, 10),
            topReels: mapStats(reelsMetadata, topReelsStats).slice(0, 10),
        },
        topScreens,
        revenueTrend: currentStats.revenueTrend,
        userGrowthTrend: currentStats.userGrowthTrend,
    };
}
