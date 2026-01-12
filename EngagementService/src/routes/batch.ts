import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
    batchInteractionRequestSchema,
    batchInteractionResponseSchema,
    userStateRequestSchema,
    userStateResponseSchema,
} from "../schemas/batch";
import { processBatchInteractions, getUserStates } from "../services/batch-service";
import { getRedisOptional } from "../lib/redis";
import { getPrismaOptional } from "../lib/prisma";

function requireUserId(headers: Record<string, unknown>): string {
    const value = headers["x-user-id"];
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    throw new Error("UNAUTHORIZED: Missing x-user-id");
}

export default fp(async function batchRoutes(fastify: FastifyInstance) {
    const redis = getRedisOptional();
    const prisma = getPrismaOptional();

    /**
     * Batch interaction sync API
     * Processes multiple like/unlike/save/unsave/view actions in one call
     */
    fastify.post("/interactions/batch", {
        schema: {
            body: batchInteractionRequestSchema,
            response: { 200: batchInteractionResponseSchema },
        },
        handler: async (request) => {
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const body = batchInteractionRequestSchema.parse(request.body);

            const result = await processBatchInteractions(
                { redis, prisma },
                userId,
                body.actions
            );

            request.log.info(
                { userId, processed: result.processed, failed: result.failed },
                "Batch interactions processed"
            );

            return batchInteractionResponseSchema.parse(result);
        },
    });

    /**
     * User state API
     * Returns like/save state and counts for multiple content items
     * Used by ContentService to enrich responses
     */
    fastify.post("/user-state", {
        schema: {
            body: userStateRequestSchema,
            response: { 200: userStateResponseSchema },
        },
        handler: async (request) => {
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const body = userStateRequestSchema.parse(request.body);

            const states = await getUserStates({ redis, prisma }, userId, body.items);

            return userStateResponseSchema.parse({ states });
        },
    });
});
