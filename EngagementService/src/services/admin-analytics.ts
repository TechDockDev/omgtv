import type { PrismaClient } from "@prisma/client";
import { StoreAnalyticsService } from "./store-analytics";
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
        episodes: any[];
    };
    saves: {
        reels: any[];
        series: any[];
        episodes: any[];
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
    const likedEpisodeIds = likedActions.filter(a => (a.contentType as string) === "EPISODE").map(a => a.contentId);
    const savedReelIds = savedActions.filter(a => a.contentType === "REEL").map(a => a.contentId);
    const savedSeriesIds = savedActions.filter(a => a.contentType === "SERIES").map(a => a.contentId);
    const savedEpisodeIds = savedActions.filter(a => (a.contentType as string) === "EPISODE").map(a => a.contentId);
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
        likedEpisodesMeta,
        savedReelsMeta,
        savedSeriesMeta,
        savedEpisodesMeta
    ] = await Promise.all([
        fetchMetadata(episodeIds, "episode"),
        fetchMetadata(likedReelIds, "reel"),
        fetchMetadata(likedSeriesIds, "series"),
        fetchMetadata(likedEpisodeIds, "episode"),
        fetchMetadata(savedReelIds, "reel"),
        fetchMetadata(savedSeriesIds, "series"),
        fetchMetadata(savedEpisodeIds, "episode")
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
        const seriesId = meta?.seriesId ?? meta?.series?.id;
        if (meta && seriesId) {
            if (!seriesMap.has(seriesId)) {
                seriesMap.set(seriesId, { completedEpisodes: new Set(), allWatchedEpisodes: new Set() });
            }
            const data = seriesMap.get(seriesId)!;
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
            episodes: mapContent(likedEpisodeIds, likedEpisodesMeta, "episode"),
        },
        saves: {
            reels: mapContent(savedReelIds, savedReelsMeta, "reel"),
            series: mapContent(savedSeriesIds, savedSeriesMeta, "series"),
            episodes: mapContent(savedEpisodeIds, savedEpisodesMeta, "episode"),
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
        totalUsers: number; // Independent of filter
        totalRevenue: MetricWithTrend;
        totalRegistered: MetricWithTrend;
        totalSubscribers: MetricWithTrend;
        
        // Detailed Subscriber Metrics
        activeSubscribers: number;
        autopayOffSubscribers: number;
        expiredSubscribers: number;
        canceledSubscribers: number;
        
        totalCanceled: number; // Sum of all canceled (Trial + Sub)

        // Detailed Trial Metrics
        activeTrials: number;
        expiredTrials: number;
        canceledTrials: number;

        // Conversion Metrics
        totalConversions: number;
        activeConversions: number;
        autopayOffConversions: number;
        expiredConversions: number;
        canceledConversions: number;

        totalLogin: MetricWithTrend;
        totalLogout: MetricWithTrend;
        totalUninstall: MetricWithTrend;

        // Official Store Stats
        storeStats: {
            androidInstalls: number;
            iosInstalls: number;
            totalInstalls: number;
            totalUninstalls: number;
        };
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
    const subStatsUrl = `${config.SUBSCRIPTION_SERVICE_URL}/internal/stats/users`;

    const uninstallUrl = `${config.NOTIFICATION_SERVICE_URL}/internal/analytics/uninstalls?startDate=${start.toISOString()}&endDate=${end.toISOString()}`;
    const appEventModel = (prisma as any).appEvent;
    const [revRes, userRes, subStatsRes, dauData, loginCount, logoutCount, uninstallRes] = await Promise.all([
        fetch(revUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ totalRevenuePaise: 0, trend: [] })),
        fetch(userUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ newCustomers: 0, totalCustomers: 0, trend: [] })),
        fetch(subStatsUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ active_subscribers: 0, active_trials: 0 })),
        prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(DISTINCT COALESCE("userId", "guestId", "deviceId")) as count 
            FROM "AppEvent" 
            WHERE "createdAt" >= ${start} AND "createdAt" <= ${end}
        `.catch(() => [{ count: BigInt(0) }]),
        appEventModel ? appEventModel.count({ where: { eventType: "login", createdAt: { gte: start, lte: end } } }).catch(() => 0) : 0,
        appEventModel ? appEventModel.count({ where: { eventType: "logout", createdAt: { gte: start, lte: end } } }).catch(() => 0) : 0,
        fetch(uninstallUrl, { headers: { "x-service-token": config.SERVICE_AUTH_TOKEN || "" } }).then(res => res.json()).catch(() => ({ uninstallCount: 0 })),
    ]);

    const dau = Number(dauData[0]?.count || 0);
    
    // New Smart Aggregation for Subscribers: Active Watching + Auto-pay Off
    const subStats = subStatsRes as any;
    const subs = subStats.subscribers || { total: 0, active_watching: 0, autopay_off_access: 0, expired_blocked: 0, expired_canceled: 0 };
    const trials = subStats.trials || { total: 0, active_watching: 0, expired_blocked: 0, expired_canceled: 0 };
    const conversions = subStats.conversions || { total: 0, active_watching: 0, autopay_off_access: 0, expired_blocked: 0, expired_canceled: 0 };
    
    const actualSubscribers = (subs.active_watching || 0) + (subs.autopay_off_access || 0) + (trials.active_watching || 0);
    const uninstallCount = (uninstallRes as any).uninstallCount || 0;

    // Official Store Stats
    const storeService = new StoreAnalyticsService(prisma);
    let storeSummary = await storeService.getStoreSummary(start, end);

    // If we have no data for yesterday and we are looking at a recent period, trigger a sync
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    if (storeSummary.totalInstalls === 0 && start <= yesterday && end >= yesterday) {
        console.log("[StoreAnalytics] No data found for period. Triggering background sync...");
        storeService.syncAll().catch(err => console.error("Background sync failed:", err));
        
        // Refetch after a short delay (optional, or just let the next load have it)
        // For now, we return 0 and let the background worker finish.
    }

    return {
        revenue: ((revRes as any).totalRevenuePaise || 0) / 100,
        newUsers: (userRes as any).newCustomers || 0,
        totalRegistered: (userRes as any).totalCustomers || 0,
        totalSubscribers: actualSubscribers,
        dau,
        login: loginCount,
        logout: logoutCount,
        uninstall: uninstallCount,
        revenueTrend: (revRes as any).trend || [],
        userGrowthTrend: (userRes as any).trend || [],
        // Raw sub stats for granular mapping
        subStats: { subs, trials, conversions },
        storeStats: storeSummary
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

    // Content Performance (Calculated for the Selected Period using AppEvents)
    const [topSeriesStatsRaw, topReelsStatsRaw] = await Promise.all([
        prisma.$queryRaw<{ contentId: string, count: bigint }[]>`
            SELECT 
                COALESCE(("eventData"->>'seriesId'), ("eventData"->>'contentId')) as "contentId",
                COUNT(*) as count
            FROM "AppEvent"
            WHERE ("eventType" = 'video_play' OR "eventType" = 'screen_view')
              AND "createdAt" >= ${currentStart} 
              AND "createdAt" <= ${currentEnd}
              AND ("eventData"->>'seriesId' IS NOT NULL OR (("eventData"->>'screen' = 'series_detail' OR "eventData"->>'screen' = 'audio_series') AND "eventData"->>'contentId' IS NOT NULL))
            GROUP BY "contentId"
            ORDER BY count DESC
            LIMIT 15
        `.catch(() => []),
        prisma.$queryRaw<{ contentId: string, count: bigint }[]>`
            SELECT 
                ("eventData"->>'contentId') as "contentId",
                COUNT(*) as count
            FROM "AppEvent"
            WHERE "eventType" = 'reel_view'
              AND "createdAt" >= ${currentStart} 
              AND "createdAt" <= ${currentEnd}
              AND "eventData"->>'contentId' IS NOT NULL
            GROUP BY "contentId"
            ORDER BY count DESC
            LIMIT 15
        `.catch(() => []),
    ]);

    // Map BigInt to Number and filter out nulls
    const topSeriesStats = topSeriesStatsRaw
        .filter(s => s.contentId && s.contentId !== 'null')
        .map(s => ({ contentId: s.contentId, viewCount: Number(s.count), likeCount: 0, saveCount: 0 }));
    
    const topReelsStats = topReelsStatsRaw
        .filter(s => s.contentId && s.contentId !== 'null')
        .map(s => ({ contentId: s.contentId, viewCount: Number(s.count), likeCount: 0, saveCount: 0 }));

    // Fallback to all-time stats if period data is empty
    if (topSeriesStats.length === 0) {
        const allTime = await prisma.contentStats.findMany({ where: { contentType: "SERIES" }, orderBy: { viewCount: "desc" }, take: 10 });
        topSeriesStats.push(...allTime.map(s => ({ contentId: s.contentId, viewCount: s.viewCount, likeCount: s.likeCount, saveCount: s.saveCount })));
    }
    if (topReelsStats.length === 0) {
        const allTime = await prisma.contentStats.findMany({ where: { contentType: "REEL" }, orderBy: { viewCount: "desc" }, take: 10 });
        topReelsStats.push(...allTime.map(s => ({ contentId: s.contentId, viewCount: s.viewCount, likeCount: s.likeCount, saveCount: s.saveCount })));
    }

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
            totalUsers: currentStats.totalRegistered, // This is all-time total
            totalRevenue: { value: currentStats.revenue, percentageChange: calculateChange(currentStats.revenue, prevStats.revenue) },
            totalRegistered: { value: currentStats.totalRegistered, percentageChange: calculateChange(currentStats.totalRegistered, prevStats.totalRegistered) },
            totalSubscribers: { value: currentStats.totalSubscribers, percentageChange: calculateChange(currentStats.totalSubscribers, prevStats.totalSubscribers) },
            
            // Subscriber Breakdown
            activeSubscribers: currentStats.subStats.subs.active_watching,
            autopayOffSubscribers: currentStats.subStats.subs.autopay_off_access,
            expiredSubscribers: currentStats.subStats.subs.expired_blocked,
            canceledSubscribers: currentStats.subStats.subs.expired_canceled,
            
            // Total Canceled matches your manual report: Auto-pay Off + Expired (Canceled)
            totalCanceled: currentStats.subStats.subs.autopay_off_access + currentStats.subStats.subs.expired_canceled + currentStats.subStats.trials.expired_canceled,

            // Trial Breakdown
            activeTrials: currentStats.subStats.trials.active_watching,
            expiredTrials: currentStats.subStats.trials.expired_blocked,
            canceledTrials: currentStats.subStats.trials.expired_canceled,

            // Conversion Breakdown
            totalConversions: currentStats.subStats.conversions.total,
            activeConversions: currentStats.subStats.conversions.active_watching,
            autopayOffConversions: currentStats.subStats.conversions.autopay_off_access,
            expiredConversions: currentStats.subStats.conversions.expired_blocked,
            canceledConversions: currentStats.subStats.conversions.expired_canceled,

            totalLogin: { value: currentStats.login, percentageChange: calculateChange(currentStats.login, prevStats.login) },
            totalLogout: { value: currentStats.logout, percentageChange: calculateChange(currentStats.logout, prevStats.logout) },
            totalUninstall: { value: currentStats.uninstall, percentageChange: calculateChange(currentStats.uninstall, prevStats.uninstall) },
            
            storeStats: {
                androidInstalls: currentStats.storeStats.android.installs,
                iosInstalls: currentStats.storeStats.ios.installs,
                totalInstalls: currentStats.storeStats.totalInstalls,
                totalUninstalls: currentStats.storeStats.totalUninstalls,
                totalCrashes: currentStats.storeStats.totalCrashes,       
            }
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

export interface CustomAdMetric {
    adId: string;
    adName: string;
    impressions: number;
    clicks: number;
    ctr: number;
}

export async function getCustomAdAnalytics(params: {
    prisma: PrismaClient;
    startDate?: string;
    endDate?: string;
}): Promise<{ summary: { totalImpressions: number, totalClicks: number, avgCtr: number }, ads: CustomAdMetric[] }> {
    const { prisma, startDate, endDate } = params;
    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();

    const appEventModel = (prisma as any).appEvent;
    if (!appEventModel) {
        console.error("[getCustomAdAnalytics] Prisma model 'appEvent' not found. Analytics data cannot be fetched.");
        return { summary: { totalImpressions: 0, totalClicks: 0, avgCtr: 0 }, ads: [] };
    }

    const events = await appEventModel.findMany({
        where: {
            eventType: { in: ["custom_ad_impression", "custom_ad_click"] },
            createdAt: { gte: start, lte: end }
        }
    });

    const adMap = new Map<string, { name: string, impressions: number, clicks: number }>();

    let totalImpressions = 0;
    let totalClicks = 0;

    events.forEach((event: any) => {
        const data = (event.eventData as any) || {};
        const adId = data.adId || data.id || data.ad_id || "unknown";
        const adName = data.adName || data.ad_name || "Unnamed Ad";

        if (!adMap.has(adId)) {
            adMap.set(adId, { name: adName, impressions: 0, clicks: 0 });
        }

        const stats = adMap.get(adId)!;
        if (event.eventType === "custom_ad_impression") {
            stats.impressions++;
            totalImpressions++;
        } else {
            stats.clicks++;
            totalClicks++;
        }
    });

    const ads: CustomAdMetric[] = Array.from(adMap.entries()).map(([adId, stats]) => {
        const ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
        return {
            adId,
            adName: stats.name,
            impressions: stats.impressions,
            clicks: stats.clicks,
            ctr: parseFloat(ctr.toFixed(2))
        };
    });

    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    return {
        summary: {
            totalImpressions,
            totalClicks,
            avgCtr: parseFloat(avgCtr.toFixed(2))
        },
        ads: ads.sort((a, b) => b.impressions - a.impressions)
    };
}
