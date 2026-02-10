import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getUserContentStats } from "../services/admin-analytics";
import { getPrismaOptional } from "../lib/prisma";

const userIdParamsSchema = z.object({
    userId: z.string().min(1),
});

const userContentStatsResponseSchema = z.object({
    watchHistory: z.array(
        z.object({
            episodeId: z.string(),
            progressSeconds: z.number(),
            durationSeconds: z.number(),
            isCompleted: z.boolean(),
            lastWatchedAt: z.string(),
        })
    ),
    likes: z.object({
        reels: z.array(z.string()),
        series: z.array(z.string()),
    }),
    saves: z.object({
        reels: z.array(z.string()),
        series: z.array(z.string()),
    }),
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
