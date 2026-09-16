
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { upsertViewProgress, getViewProgress, addReview } from "../services/collection-engagement";
import { submitContentReport } from "../services/content-report-service";
import { getContentReportStatusByTicket, listContentReportsForUser } from "../services/content-report-admin-service";
import { getRedisOptional } from "../lib/redis";
import { getPrismaOptional } from "../lib/prisma";
import { seriesIdParamsSchema } from "../schemas/engagement";
import { addReviewBodySchema } from "../schemas/review";
import { submitReportBodySchema } from "../schemas/report";

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

    // Add review
    fastify.post("/reviews/:seriesId", {
        schema: {
            params: seriesIdParamsSchema,
            body: addReviewBodySchema,
        },
        handler: async (request) => {
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const { seriesId } = seriesIdParamsSchema.parse(request.params);
            const body = addReviewBodySchema.parse(request.body);

            const userName = body.user_name ?? (request.headers["x-user-name"] as string) ?? "User";

            const result = await addReview({
                redis,
                prisma,
                entityType: "series",
                entityId: seriesId,
                userId,
                userName,
                rating: body.rating,
                comment: body.comment,
            });

            return { review_id: result.reviewId };
        },
    });

    // Report content / grievance — intentionally no requireUserId: the form
    // collects name/email directly and must be reachable without an account.
    fastify.post("/reports", {
        schema: {
            body: submitReportBodySchema,
        },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }
            const body = submitReportBodySchema.parse(request.body);
            const userIdHeader = request.headers["x-user-id"];
            const userId = typeof userIdHeader === "string" && userIdHeader ? userIdHeader : undefined;

            const result = await submitContentReport({
                prisma,
                userId,
                reporterName: body.reporter_name,
                reporterEmail: body.reporter_email,
                movieShowName: body.movie_show_name,
                episodeName: body.episode_name,
                videoTimestamp: body.video_timestamp,
                reason: body.reason,
            });

            return reply.send({ ticket_id: result.ticketId });
        },
    });

    // List my complaints — requires login (bearer token, enforced at APIGW;
    // this route just reads the x-user-id header it injects).
    const listMyReportsQuerySchema = z.object({
        page: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(100).default(20),
    });

    fastify.get("/reports", {
        schema: {
            querystring: listMyReportsQuerySchema,
        },
        handler: async (request) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }
            const userId = requireUserId(request.headers as Record<string, unknown>);
            const { page, limit } = listMyReportsQuerySchema.parse(request.query);

            return listContentReportsForUser({ prisma, userId, page, limit });
        },
    });

    // Check complaint status — public, requires ticket ID + the email it was
    // submitted with (basic proof-of-ownership beyond guessing the ticket ID).
    const reportStatusParamsSchema = z.object({
        ticketId: z.string().min(1),
    });
    const reportStatusQuerySchema = z.object({
        email: z.string().trim().email(),
    });

    fastify.get("/reports/:ticketId/status", {
        schema: {
            params: reportStatusParamsSchema,
            querystring: reportStatusQuerySchema,
        },
        handler: async (request, reply) => {
            if (!prisma) {
                throw fastify.httpErrors.serviceUnavailable("Database not available");
            }
            const { ticketId } = reportStatusParamsSchema.parse(request.params);
            const { email } = reportStatusQuerySchema.parse(request.query);

            const result = await getContentReportStatusByTicket({
                prisma,
                ticketId,
                reporterEmail: email,
            });

            if (!result) {
                return reply.code(404).send({ error: "Report not found" });
            }

            return reply.send(result);
        },
    });
}
