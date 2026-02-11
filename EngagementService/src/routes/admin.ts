import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
    getUserContentStats,
    getGeneralDashboardStats,
} from "../services/admin-analytics";
import { getPrismaOptional } from "../lib/prisma";

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

const contentDetailSchema = z.object({
    id: z.string(),
    title: z.string(),
    thumbnailUrl: z.string().nullable(),
    manifestUrl: z.string().nullable(),
});

const userContentStatsResponseSchema = z.object({
    watchHistory: z.array(
        z.object({
            episodeId: z.string(),
            title: z.string(),
            thumbnailUrl: z.string().nullable(),
            manifestUrl: z.string().nullable(),
            progressSeconds: z.number(),
            durationSeconds: z.number(),
            isCompleted: z.boolean(),
            lastWatchedAt: z.string(),
        })
    ),
    likes: z.object({
        reels: z.array(contentDetailSchema),
        series: z.array(contentDetailSchema),
    }),
    saves: z.object({
        reels: z.array(contentDetailSchema),
        series: z.array(contentDetailSchema),
    }),
    ongoingSeries: z.array(z.any()),
    completedSeries: z.array(z.any()),
    stats: z.object({
        totalWatchTimeSeconds: z.number(),
        episodesStarted: z.number(),
        episodesCompleted: z.number(),
        totalLikes: z.number(),
        totalSaves: z.number(),
    }),
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

    fastify.get("/analytics/users/:userId/content", {
        schema: {
            params: userIdParamsSchema,
            response: { 200: userContentStatsResponseSchema },
        },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable(
                    "Database not available"
                );
            }

            const { userId } = userIdParamsSchema.parse(request.params);

            const result = await getUserContentStats({
                prisma,
                userId,
            });

            return result;
        },
    });
}
