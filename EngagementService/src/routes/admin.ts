import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
    getUserContentStats,
    getGeneralDashboardStats,
    getCustomAdAnalytics,
} from "../services/admin-analytics";
import { getReviews, deleteReview } from "../services/collection-engagement";
import { getPrismaOptional } from "../lib/prisma";
import { getRedisOptional } from "../lib/redis";
import { userContentStatsResponseSchema } from "../schemas/admin-analytics";
import { reviewsResponseSchema, getReviewsQuerySchema } from "../schemas/review";

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
        canceledSubscribers: z.number(),
        totalCanceled: z.number(),

        // Detailed Trial Metrics
        activeTrials: z.number(),
        expiredTrials: z.number(),
        canceledTrials: z.number(),

        // Conversion Metrics
        totalConversions: z.number(),
        activeConversions: z.number(),
        autopayOffConversions: z.number(),
        expiredConversions: z.number(),
        canceledConversions: z.number(),

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
                        installs: z.number(),
                        uninstalls: z.number(),
                        impressions: z.number(),
                        pageViews: z.number(),
                        sessions: z.number().nullable(),
                        crashes: z.number(),
                        anrs: z.number(),
                        averageRating: z.number().nullable(),
                        lastSyncedAt: z.date()
                    }))
                })
            }
        },
        handler: async (request) => {
            if (!prisma) throw fastify.httpErrors.serviceUnavailable("Database not available");
            const { startDate, endDate } = request.query as any;
            const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const end = endDate ? new Date(endDate) : new Date();

            const stats = await prisma.storeAnalytics.findMany({
                where: { date: { gte: start, lte: end } },
                orderBy: { date: "desc" }
            });
            return { stats };
        }
    });

    // Manual Store Sync Trigger
    fastify.post("/analytics/store/sync", {
        handler: async (request) => {
            if (!prisma) throw fastify.httpErrors.serviceUnavailable("Database not available");
            const { StoreAnalyticsService } = await import("../services/store-analytics");
            const service = new StoreAnalyticsService(prisma);
            await service.syncAll();
            return { success: true, message: "Sync triggered and completed" };
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

    const userContentQuerySchema = z.object({
        limit: z.coerce.number().min(1).max(100).optional().default(50),
        offset: z.coerce.number().min(0).optional().default(0),
    });

    fastify.get("/analytics/users/:userId/content", {
        schema: {
            params: userIdParamsSchema,
            querystring: userContentQuerySchema,
            response: { 200: userContentStatsResponseSchema },
        },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable(
                    "Database not available"
                );
            }

            const { userId } = userIdParamsSchema.parse(request.params);
            const { limit, offset } = userContentQuerySchema.parse(request.query);

            const result = await getUserContentStats({
                prisma,
                userId,
                limit,
                offset,
            });

            return result;
        },
    });

    // Bulk user stats for admin app-users listing
    const bulkUserStatsSchema = z.object({
        userIds: z.array(z.string().min(1)).min(1).max(100),
    });

    fastify.post("/analytics/users/bulk-stats", {
        schema: {
            body: bulkUserStatsSchema,
        },
        handler: async (request) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }

            const { userIds } = bulkUserStatsSchema.parse(request.body);

            // Aggregate watch time and episode count per user in one query
            const watchStats = await prisma.viewProgress.groupBy({
                by: ["userId"],
                where: { userId: { in: userIds } },
                _sum: { progressSeconds: true },
                _count: { episodeId: true },
            });

            const stats: Record<string, { totalWatchTimeSeconds: number; contentViewed: number }> = {};

            // Initialize all requested users with zeros
            for (const uid of userIds) {
                stats[uid] = { totalWatchTimeSeconds: 0, contentViewed: 0 };
            }

            // Fill in actual data
            for (const row of watchStats) {
                stats[row.userId] = {
                    totalWatchTimeSeconds: row._sum.progressSeconds || 0,
                    contentViewed: row._count.episodeId || 0,
                };
            }

            return { stats };
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
