import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushNotificationService } from '../services/PushNotificationService';
import prisma from '../prisma';
import { loadConfig } from '../config';
import { NotificationType } from '@prisma/client';

const sendPushSchema = z.object({
    userId: z.string(),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    type: z.string().optional(),
});

export default async function internalPushRoutes(fastify: FastifyInstance) {
    fastify.post('/send', async (request, reply) => {
        const { userId, title, body, data, priority, type } = sendPushSchema.parse(request.body);

        // 1. Create the notification record in DB IMMEDIATELY (In-App persistence)
        // This ensures history is visible even if push fails or tokens are missing
        const notification = await prisma.notification.create({
            data: {
                userId,
                type: (type as NotificationType) || NotificationType.PUSH,
                title,
                body,
                data: data || {},
                status: 'PENDING',
                priority: priority || 'MEDIUM',
            },
        });

        // 2. Fetch tokens from UserService via the AuthSubject ID endpoint
        const config = loadConfig();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (config.SERVICE_AUTH_TOKEN) {
            headers['x-service-token'] = config.SERVICE_AUTH_TOKEN;
        }

        try {
            const userSvcUrl = config.USER_SERVICE_URL;
            const resp = await fetch(`${userSvcUrl}/internal/users/fcm-tokens-by-auth-id`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ authIds: [userId] }),
            });

            if (!resp.ok) {
                console.error(`[internal-push] Failed to fetch FCM tokens from UserService for userId: ${userId}, status: ${resp.status}`);
                await prisma.notification.update({ where: { id: notification.id }, data: { status: 'FAILED' } });
                return reply.send({ success: false, notificationId: notification.id, reason: 'user_service_error' });
            }

            const json = await resp.json() as { tokens: { userId: string, fcmToken: string, deviceId: string }[] };
            const fcmTokens = json.tokens || [];

            if (fcmTokens.length === 0) {
                console.warn(`[internal-push] No FCM tokens found for user ${userId}. Push skipped.`);
                // We keep it as PENDING or maybe MARK it as SKIPPED? 
                // Let's set to SENT since it's "available" in-app now.
                await prisma.notification.update({ where: { id: notification.id }, data: { status: 'SENT' } });
                return reply.send({ success: true, notificationId: notification.id, pushSent: false, reason: 'no_tokens' });
            }

            // 3. Send Push Notification via Firebase
            const tokens = [...new Set(fcmTokens.map(t => t.fcmToken))];
            const result = await pushNotificationService.sendToMultipleDevices(tokens, { title, body, data });

            // 4. Update the record with delivery status
            await prisma.notification.update({
                where: { id: notification.id },
                data: {
                    status: result.successCount > 0 ? 'SENT' : 'FAILED',
                    fcmMessageId: result.responses.find(r => r.messageId)?.messageId,
                    fcmError: result.failureCount > 0 ? JSON.stringify(result.responses.filter(r => r.error)) : undefined,
                },
            });

            return reply.send({
                success: true,
                notificationId: notification.id,
                pushSent: result.successCount > 0,
                successCount: result.successCount,
                failureCount: result.failureCount,
            });
        } catch (error: any) {
            console.error(`[internal-push] Error processing notification ${notification.id}:`, error);
            await prisma.notification.update({ where: { id: notification.id }, data: { status: 'FAILED' } });
            return reply.status(500).send({ success: false, notificationId: notification.id, error: error.message });
        }
    });
}
