
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../prisma';

export default async function internalAnalyticsRoutes(fastify: FastifyInstance) {
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
