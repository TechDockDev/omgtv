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
    // Middleware check for admin role should be here
    // For now assuming internal network or API gateway handles auth

    /**
     * POST /admin/notifications/send
     * Send notification to specific user
     */
    server.post('/send', {
        schema: { body: sendNotificationSchema },
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
        const { userId, title, body, data, type, priority } = sendNotificationSchema.parse(request.body);

        try {
            // Create In-App Notification
            const notification = await NotificationRepository.create({
                userId,
                type: type === 'PUSH' ? 'PUSH' : 'IN_APP', // Mapping enum
                title,
                body,
                data: data || {},
                priority,
                status: 'PENDING'
            });

            console.log("notificaion", notification)
            // If Push, also trigger FCM
            if (type === 'PUSH') {
                const fcmTokens = await prisma.fcmToken.findMany({ where: { userId } });
                console.log("fcmTokens", fcmTokens)
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
     * POST /admin/notifications/broadcast
     * Send notification to ALL users
     */
    server.post('/broadcast', {
        schema: { body: broadcastNotificationSchema },
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
        const { title, body, data, priority } = broadcastNotificationSchema.parse(request.body);

        try {
            // 1. Send via FCM Topic "all-users" (most efficient for push)
            const pushResult = await pushNotificationService.sendToTopic('all-users', {
                title,
                body,
                data
            });

            // 2. Create database records for In-App feed?
            // Creating 1M records here is bad. Usually we create a "GlobalNotification" table
            // and merge it on read. For MVP, we might just log it or skip DB for broadcast if strictly push.
            // OR use a background job to fan-out.
            // Let's create a single System Notification record for reference.

            // For now, returning success of Push Broadcast
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
     * GET /admin/notifications/stats
     * Get simple stats
     */
    server.get('/stats', {
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
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
