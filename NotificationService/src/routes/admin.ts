import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotificationRepository } from '../repositories/notification';
import { pushNotificationService } from '../services/PushNotificationService';
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
    }, async (request, reply) => {
        const { userId, title, body, data, type, priority } = sendNotificationSchema.parse(request.body);

        try {
            const notification = await NotificationRepository.create({
                userId,
                type: type === 'PUSH' ? 'PUSH' : 'IN_APP',
                title,
                body,
                data: data || {},
                priority,
                status: 'PENDING'
            });

            if (type === 'PUSH') {
                const fcmTokens = await prisma.fcmToken.findMany({ where: { userId } });
                if (fcmTokens.length > 0) {
                    pushNotificationService.sendToMultipleDevices(
                        fcmTokens.map((t: { token: string }) => t.token),
                        { title, body, data }
                    ).catch(err => server.log.error(err, 'Failed to send push in admin flow'));
                }
            }

            return { success: true, notificationId: notification.id };
        } catch (error) {
            server.log.error(error, 'Failed to send admin notification');
            return reply.code(500).send({ error: 'Failed to send notification' });
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
}
