import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushNotificationService } from '../services/PushNotificationService';
import prisma from '../prisma';
import { loadConfig } from '../config';
import { NotificationType } from '@prisma/client';
import { userProvider } from '../providers/UserProvider';

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

        const config = loadConfig();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.SERVICE_AUTH_TOKEN) {
            headers['x-service-token'] = config.SERVICE_AUTH_TOKEN;
        }

        // 1. Fetch FCM tokens first — no DB touch until we know we can deliver
        const userSvcUrl = config.USER_SERVICE_URL;
        const resp = await fetch(`${userSvcUrl}/internal/users/fcm-tokens-by-auth-id`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ authIds: [userId] }),
        });

        if (!resp.ok) {
            console.error(`[internal-push] Failed to fetch FCM tokens from UserService for userId: ${userId}, status: ${resp.status}`);
            return reply.status(502).send({ success: false, reason: 'user_service_error' });
        }

        const json = await resp.json() as { tokens: { userId: string, fcmToken: string, deviceId: string }[] };
        const fcmTokens = json.tokens || [];

        if (fcmTokens.length === 0) {
            console.warn(`[internal-push] No FCM tokens found for user ${userId}. Push skipped.`);
            return reply.send({ success: true, pushSent: false, reason: 'no_tokens' });
        }

        // 2. Send push via Firebase
        const tokens = [...new Set(fcmTokens.map(t => t.fcmToken))];
        const result = await pushNotificationService.sendToMultipleDevices(tokens, { title, body, data });

        // Clean up stale tokens FCM rejected as unregistered (fire-and-forget)
        const staleTokens = tokens.filter((_, idx) => {
            const err = result.responses[idx]?.error as any;
            return err?.code === 'messaging/registration-token-not-registered';
        });
        if (staleTokens.length > 0) {
            userProvider.removeStaleTokens(staleTokens).catch(() => {});
        }

        // 3. Persist notification record after FCM — if DB fails, push already went out so don't retry
        try {
            const notification = await prisma.notification.create({
                data: {
                    userId,
                    type: (type as NotificationType) || NotificationType.PUSH,
                    title,
                    body,
                    data: data || {},
                    status: result.successCount > 0 ? 'SENT' : 'FAILED',
                    priority: priority || 'MEDIUM',
                    fcmMessageId: result.responses.find((r: any) => r.messageId)?.messageId,
                    fcmError: result.failureCount > 0 ? JSON.stringify(result.responses.filter((r: any) => r.error)) : undefined,
                },
            });

            return reply.send({
                success: true,
                notificationId: notification.id,
                pushSent: result.successCount > 0,
                successCount: result.successCount,
                failureCount: result.failureCount,
            });
        } catch (dbErr: any) {
            // Push already sent — log DB failure but return success so caller doesn't retry
            console.error(`[internal-push] DB write failed after FCM send for userId ${userId}:`, dbErr?.message);
            return reply.send({
                success: true,
                pushSent: result.successCount > 0,
                successCount: result.successCount,
                failureCount: result.failureCount,
            });
        }
    });
}
