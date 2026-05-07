import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotificationRepository } from '../repositories/notification';
import { NotificationManager } from '../services/notification-manager';
import { pushNotificationService } from '../services/PushNotificationService';
import { userProvider } from '../providers/UserProvider';
import prisma from '../prisma';

const sendNotificationSchema = z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    type: z.enum(['EMAIL', 'PUSH', 'IN_APP']).default('IN_APP'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
});

const broadcastNotificationSchema = z.object({
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
});

export default async function adminRoutes(server: FastifyInstance) {
    // All admin routes require admin access
    server.addHook('onRequest', server.requireAdmin);

    /**
     * POST /admin/send
     * Send notification to specific user
     */
    server.post('/send', {
        schema: { body: sendNotificationSchema },
    }, async (request) => {
        const { userId, title, body, data, type, priority } = sendNotificationSchema.parse(request.body);

        try {
            const manager = new NotificationManager();
            const notification = await manager.sendNotification(
                userId,
                type as any,
                title,
                body,
                data,
                priority as any
            );

            return { success: true, notificationId: notification?.id };
        } catch (error) {
            server.log.error(error, 'Failed to send admin notification');
            throw server.httpErrors.internalServerError('Failed to send notification');
        }
    });

    /**
     * POST /admin/broadcast
     * Send notification to ALL users
     */
    server.post('/broadcast', {
        schema: { body: broadcastNotificationSchema },
    }, async (request, reply) => {
        const { title, body, data } = broadcastNotificationSchema.parse(request.body);

        try {
            const pushResult = await pushNotificationService.sendToTopic('all-users', {
                title,
                body,
                data
            });

            return {
                success: true,
                pushResult
            };
        } catch (error) {
            server.log.error(error, 'Failed to broadcast notification');
            return reply.code(500).send({ error: 'Failed to broadcast' });
        }
    });

    /**
     * GET /admin/stats
     * Get notification statistics
     */
    server.get('/stats', async () => {
        const total = await prisma.notification.count();
        const pending = await prisma.notification.count({ where: { status: 'PENDING' } });
        const sent = await prisma.notification.count({ where: { status: 'SENT' } });
        const failed = await prisma.notification.count({ where: { status: 'FAILED' } });
        const read = await prisma.notification.count({ where: { status: 'READ' } });

        return {
            total,
            pending,
            sent,
            failed,
            read
        };
    });

    /**
     * GET /admin/payment-notifications/stats
     * Breakdown of payment push notifications by trigger type
     */
    server.get('/payment-notifications/stats', async () => {
        const triggerTypes = [
            'SUBSCRIPTION_ACTIVATED',
            'SUBSCRIPTION_RENEWED',
            'SUBSCRIPTION_PAYMENT_FAILED',
            'COIN_PURCHASE_SUCCESS',
            'COIN_PURCHASE_FAILED',
        ] as const;

        const stats = await Promise.all(
            triggerTypes.map(async (type) => {
                const [sent, failed, read] = await Promise.all([
                    prisma.notification.count({
                        where: { status: 'SENT', data: { path: ['type'], equals: type } },
                    }),
                    prisma.notification.count({
                        where: { status: 'FAILED', data: { path: ['type'], equals: type } },
                    }),
                    prisma.notification.count({
                        where: { status: 'READ', data: { path: ['type'], equals: type } },
                    }),
                ]);
                return { type, sent, failed, read, total: sent + failed + read };
            })
        );

        const overall = stats.reduce(
            (acc, s) => ({
                sent: acc.sent + s.sent,
                failed: acc.failed + s.failed,
                read: acc.read + s.read,
                total: acc.total + s.total,
            }),
            { sent: 0, failed: 0, read: 0, total: 0 }
        );

        return { overall, breakdown: stats };
    });

    /**
     * GET /admin/payment-notifications?type=&status=&limit=&offset=
     * List recent payment push notifications with optional filters
     */
    server.get('/payment-notifications', {
        schema: {
            querystring: z.object({
                type: z.enum([
                    'SUBSCRIPTION_ACTIVATED',
                    'SUBSCRIPTION_RENEWED',
                    'SUBSCRIPTION_PAYMENT_FAILED',
                    'COIN_PURCHASE_SUCCESS',
                    'COIN_PURCHASE_FAILED',
                ]).optional(),
                status: z.enum(['SENT', 'FAILED', 'READ']).optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
                offset: z.coerce.number().int().min(0).default(0),
            }),
        },
    }, async (request) => {
        const { type, status, limit, offset } = request.query as {
            type?: string;
            status?: string;
            limit: number;
            offset: number;
        };

        const paymentTypes = [
            'SUBSCRIPTION_ACTIVATED',
            'SUBSCRIPTION_RENEWED',
            'SUBSCRIPTION_PAYMENT_FAILED',
            'COIN_PURCHASE_SUCCESS',
            'COIN_PURCHASE_FAILED',
        ];

        // Prisma JSON path filter doesn't support `in` — use OR instead
        const typeFilter = type
            ? { data: { path: ['type'], equals: type } }
            : { OR: paymentTypes.map(t => ({ data: { path: ['type'], equals: t } })) };

        const where: any = { ...typeFilter };
        if (status) where.status = status;

        const [notifications, total] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: offset,
                select: {
                    id: true,
                    userId: true,
                    title: true,
                    body: true,
                    data: true,
                    status: true,
                    fcmError: true,
                    createdAt: true,
                },
            }),
            prisma.notification.count({ where }),
        ]);

        // Enrich with user profiles (name, email, phone)
        const userIds = [...new Set(notifications.map(n => n.userId))];
        const profiles = await userProvider.getUserProfiles(userIds);

        const enriched = notifications.map(n => ({
            ...n,
            user: profiles[n.userId] ?? { name: null, email: null, phone: null },
        }));

        return { total, limit, offset, notifications: enriched };
    });
}
