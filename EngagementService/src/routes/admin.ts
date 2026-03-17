import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
    getUserContentStats,
    getGeneralDashboardStats,
} from "../services/admin-analytics";
import { getPrismaOptional } from "../lib/prisma";
import { userContentStatsResponseSchema } from "../schemas/admin-analytics";

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
        totalRevenue: metricWithTrendSchema,
        totalSubscribers: metricWithTrendSchema,
        totalLogin: metricWithTrendSchema,
        totalLogout: metricWithTrendSchema,
        totalUninstall: metricWithTrendSchema,
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
}
