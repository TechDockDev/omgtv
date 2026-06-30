import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StoreAnalyticsService } from "../services/store-analytics";
import {
    getUserContentStats,
    getGeneralDashboardStats,
    getCustomAdAnalytics,
} from "../services/admin-analytics";
import { getReviews, deleteReview } from "../services/collection-engagement";
import { getSeriesAnalyticsReport, seriesAnalyticsToCsv } from "../services/series-analytics";
import { getPrismaOptional } from "../lib/prisma";
import { getRedisOptional } from "../lib/redis";
import { userContentStatsResponseSchema } from "../schemas/admin-analytics";
import { reviewsResponseSchema, getReviewsQuerySchema } from "../schemas/review";
import { resolveIstDateRange } from "../utils/date-range";

const userIdParamsSchema = z.object({
    userId: z.string().min(1),
});

const dashboardQuerySchema = z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    granularity: z.enum(["daily", "monthly", "yearly"]).optional().default("daily"),
});

const metricWithTrendSchema = z.object({
    value: z.number(),
    percentageChange: z.number(),
});

const dashboardResponseSchema = z.object({
    overview: z.object({
        dau: metricWithTrendSchema,
        newUsers: metricWithTrendSchema,
        totalUsers: z.number(),
        totalRevenue: metricWithTrendSchema,
        totalRegistered: metricWithTrendSchema,
        totalSubscribers: metricWithTrendSchema,
        
        // Detailed Subscriber Metrics
        activeSubscribers: z.number(),
        autopayOffSubscribers: z.number(),
        expiredSubscribers: z.number(),

        // Detailed Trial Metrics
        activeTrials: z.number(),
        expiredTrials: z.number(),

        // Cancellation Stats — per-subscription logic, matches /admin/canceled-users
        canceledTotal: z.number(),
        canceledTrial: z.number(),
        canceledTrialExpired: z.number(),
        canceledSubscription: z.number(),
        canceledSubscriptionExpired: z.number(),
        canceledConverted: z.number(),
        canceledConvertedExpired: z.number(),

        // Conversion Metrics
        totalConversions: z.number(),
        activeConversions: z.number(),
        autopayOffConversions: z.number(),
        expiredConversions: z.number(),
        canceledConversions: z.number(),

        activeViewers: metricWithTrendSchema,
        totalWatchTime: metricWithTrendSchema,
        churnRate: z.object({
            overall: metricWithTrendSchema,
            paid:    metricWithTrendSchema,
            trial:   metricWithTrendSchema,
        }),
        totalLogin: metricWithTrendSchema,
        totalLogout: metricWithTrendSchema,
        totalUninstall: metricWithTrendSchema,

        // Official Store Stats
        storeStats: z.object({
            androidInstalls: z.number(),
            iosInstalls: z.number(),
            totalInstalls: z.number(),
            totalUninstalls: z.number(),
            totalCrashes: z.number().optional(),      // New
        }),
    }),
    contentPerformance: z.object({
        topSeries: z.array(z.any()),
        topReels: z.array(z.any()),
    }),
    topScreens: z.array(z.object({
        name: z.string(),
        viewCount: z.number(),
    })),
    revenueTrend: z.array(z.object({
        date: z.string(),
        value: z.number(),
    })),
    userGrowthTrend: z.array(z.object({
        date: z.string(),
        value: z.number(),
    })),
});

export default async function adminRoutes(fastify: FastifyInstance) {
    const prisma = getPrismaOptional();

    fastify.get("/analytics/dashboard", {
        schema: {
            querystring: dashboardQuerySchema,
            response: { 200: dashboardResponseSchema },
        },
        handler: async (request) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable(
                    "Database not available"
                );
            }
            const { startDate, endDate, granularity } = request.query as z.infer<typeof dashboardQuerySchema>;
            return await getGeneralDashboardStats({ prisma, startDate, endDate, granularity });
        },
    });

    // Official Store Deep Dive
    fastify.get("/analytics/store", {
        schema: {
            querystring: z.object({
                startDate: z.string().optional(),
                endDate: z.string().optional(),
            }),
            response: {
                200: z.object({
                    stats: z.array(z.object({
                        platform: z.string(),
                        date: z.date(),
                        activeOpens: z.number(),
                        uninstalls: z.number(),
                        impressions: z.number(),
                        pageViews: z.number(),
                        sessions: z.number().nullable(),
                        crashes: z.number(),
                        anrs: z.number(),
                        averageRating: z.number().nullable(),
                        lastSyncedAt: z.date()
                    })),
                    summary: z.object({
                        ios: z.object({ activeOpens: z.number(), impressions: z.number() }),
                        android: z.object({ activeOpens: z.number(), impressions: z.number() }),
                        totalActiveOpens: z.number()
                    })
                })
            }
        },
        handler: async (request) => {
            if (!prisma) throw fastify.httpErrors.serviceUnavailable("Database not available");
            const { startDate, endDate } = request.query as any;
            const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const end = endDate ? new Date(endDate) : new Date();

            const [dbStats, iosTotals, androidTotals] = await Promise.all([
                prisma.storeAnalytics.findMany({
                    where: { date: { gte: start, lte: end } },
                    orderBy: { date: "desc" }
                }),
                prisma.storeAnalytics.aggregate({
                    where: { platform: "ios" },
                    _sum: { installs: true, impressions: true }
                }),
                prisma.storeAnalytics.aggregate({
                    where: { platform: "android" },
                    _sum: { installs: true, impressions: true }
                })
            ]);

            // Map DB 'installs' to API 'activeOpens'
            const stats = dbStats.map(s => ({
                ...s,
                activeOpens: s.installs
            }));

            const summary = {
                ios: {
                    activeOpens: iosTotals._sum.installs || 0,
                    impressions: iosTotals._sum.impressions || 0
                },
                android: {
                    activeOpens: androidTotals._sum.installs || 0,
                    impressions: androidTotals._sum.impressions || 0
                },
                totalActiveOpens: (iosTotals._sum.installs || 0) + (androidTotals._sum.installs || 0)
            };

            return { stats, summary };
        }
    });

    // Manual Store Sync Trigger
    fastify.post("/analytics/store/sync", {
        handler: async (request, reply) => {
            if (!prisma) throw fastify.httpErrors.serviceUnavailable("Database not available");
            try {
                const service = new StoreAnalyticsService(prisma);
                await service.syncAll();
                return { success: true, message: "Sync triggered and completed" };
            } catch (err: any) {
                fastify.log.error({ err }, "Store sync failed");
                return reply.code(500).send({ success: false, message: err?.message || "Sync failed" });
            }
        }
    });

    fastify.get("/analytics/ads/custom", {
        schema: {
            querystring: z.object({
                startDate: z.string().optional(),
                endDate: z.string().optional(),
            }),
        },
        handler: async (request) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }
            const { startDate, endDate } = request.query as any;
            return await getCustomAdAnalytics({ prisma, startDate, endDate });
        },
    });

    // Series-level analytics report (watch hours, completions, likes/saves, ratings)
    // with a date-range filter. Page views and ratings are all-time — see series-analytics.ts.
    const seriesReportQuerySchema = z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        format: z.enum(["json", "csv"]).optional().default("json"),
    });

    fastify.get("/analytics/series-report", {
        schema: { querystring: seriesReportQuerySchema },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }
            const { startDate, endDate, format } = seriesReportQuerySchema.parse(request.query);
            const { start, end } = resolveIstDateRange(startDate, endDate);
            const rows = await getSeriesAnalyticsReport({ prisma, start, end });

            if (format === "csv") {
                reply.header("Content-Type", "text/csv");
                reply.header(
                    "Content-Disposition",
                    `attachment; filename="series-analytics-${startDate ?? "last30d"}-to-${endDate ?? "now"}.csv"`
                );
                return seriesAnalyticsToCsv(rows);
            }

            return {
                range: { startDate: start.toISOString(), endDate: end.toISOString() },
                series: rows,
            };
        },
    });

    // --- Review Management ---

    const redis = getRedisOptional();

    // GET all reviews for a series (admin view)
    const seriesIdParamsSchema = z.object({
        seriesId: z.string().uuid(),
    });

    fastify.get("/reviews/:seriesId", {
        schema: {
            params: seriesIdParamsSchema,
            querystring: getReviewsQuerySchema,
            response: { 200: reviewsResponseSchema },
        },
        handler: async (request) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }

            const { seriesId } = seriesIdParamsSchema.parse(request.params);
            const query = getReviewsQuerySchema.parse(request.query);

            const result = await getReviews({
                redis,
                prisma,
                entityType: "series",
                entityId: seriesId,
                limit: query.limit,
                cursor: query.cursor,
            });

            return {
                summary: {
                    average_rating: result.averageRating,
                    total_reviews: result.totalReviews,
                },
                user_reviews: result.reviews as any[],
                next_cursor: result.nextCursor,
            };
        },
    });

    // DELETE a review by ID (admin moderation)
    const reviewIdParamsSchema = z.object({
        reviewId: z.string().uuid(),
    });

    fastify.delete("/reviews/:reviewId", {
        schema: {
            params: reviewIdParamsSchema,
        },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }

            const { reviewId } = reviewIdParamsSchema.parse(request.params);

            const result = await deleteReview({
                redis,
                prisma,
                reviewId,
            });

            if (!result.deleted) {
                return reply.code(404).send({ error: "Review not found" });
            }

            return {
                success: true,
                message: "Review deleted successfully",
                contentType: result.contentType,
                contentId: result.contentId,
            };
        },
    });
}
