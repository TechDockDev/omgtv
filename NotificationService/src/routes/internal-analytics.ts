
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../prisma';

export default async function internalAnalyticsRoutes(fastify: FastifyInstance) {
    // POST /internal/notifications/bulk-history
    // Returns last sent timestamp + count per user for a given notification type
    fastify.post('/notifications/bulk-history', {
        schema: {
            body: z.object({
                userIds: z.array(z.string().min(1)).min(1).max(500),
                type: z.string().optional(),
            }),
        },
    }, async (request) => {
        const { userIds, type } = request.body as { userIds: string[]; type?: string };

        const rows = await prisma.notification.groupBy({
            by: ['userId'],
            where: {
                userId: { in: userIds },
                // type filters on the data JSON field (e.g. AT_RISK_CAMPAIGN), not the NotificationType enum
                ...(type ? { data: { path: ['type'], equals: type } } : {}),
            },
            _count: { id: true },
            _max: { createdAt: true },
        });

        const history: Record<string, { lastSentAt: string | null; count: number }> = {};
        for (const uid of userIds) {
            history[uid] = { lastSentAt: null, count: 0 };
        }
        for (const row of rows) {
            history[row.userId] = {
                lastSentAt: row._max.createdAt ? row._max.createdAt.toISOString() : null,
                count: row._count.id,
            };
        }

        return { history };
    });

    /**
     * GET /internal/analytics/uninstalls
     * Returns the number of confirmed uninstalls (FCM Not Registered error) within a date range
     */
    fastify.get('/analytics/uninstalls', {
        schema: {
            querystring: z.object({
                startDate: z.string().datetime(),
                endDate: z.string().datetime(),
            })
        }
    }, async (request, reply) => {
        const { startDate, endDate } = request.query as { startDate: string, endDate: string };
        const start = new Date(startDate);
        const end = new Date(endDate);

        // Confirmed uninstall = FAILED status AND fcmError containing 'not-registered'
        // We look specifically for 'messaging/registration-token-not-registered'
        const uninstallCount = await prisma.notification.count({
            where: {
                status: 'FAILED',
                fcmError: {
                    contains: 'registration-token-not-registered'
                },
                createdAt: {
                    gte: start,
                    lte: end
                }
            }
        });

        return { uninstallCount };
    });
}
