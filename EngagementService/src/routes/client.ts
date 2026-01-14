
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { upsertViewProgress, getViewProgress } from "../services/collection-engagement";
import { getRedisOptional } from "../lib/redis";
import { getPrismaOptional } from "../lib/prisma";

// Schemas
const saveProgressSchema = z.object({
    episodeId: z.string().uuid(),
    progressSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive(),
});

const getProgressParamsSchema = z.object({
    episodeId: z.string().uuid(),
});

// Middleware helper
function requireUserId(headers: Record<string, unknown>): string {
    const userId = headers["x-user-id"];
    if (typeof userId !== "string" || !userId) {
        throw new Error("Missing user ID header");
    }
    return userId;
}

export default async function clientRoutes(fastify: FastifyInstance) {
    const redis = getRedisOptional();
    const prisma = getPrismaOptional();

    // Save view progress
    fastify.post("/progress", {
        schema: {
            body: saveProgressSchema,
        },
        handler: async (request) => {
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const body = saveProgressSchema.parse(request.body);

            const result = await upsertViewProgress({
                redis,
                prisma,
                userId,
                episodeId: body.episodeId,
                progressSeconds: body.progressSeconds,
                durationSeconds: body.durationSeconds,
            });

            request.log.info(
                { userId, episodeId: body.episodeId, progress: body.progressSeconds },
                "Saved view progress"
            );

            return result;
        },
    });

    // Get view progress
    fastify.get("/progress/:episodeId", {
        schema: {
            params: getProgressParamsSchema,
        },
        handler: async (request) => {
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const params = getProgressParamsSchema.parse(request.params);

            const result = await getViewProgress({
                redis,
                prisma,
                userId,
                episodeId: params.episodeId,
            });

            if (!result) {
                return {
                    progressSeconds: 0,
                    durationSeconds: 0,
                    completedAt: null,
                };
            }

            return result;
        },
    });
}
