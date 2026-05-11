import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushNotificationService } from '../services/PushNotificationService';
import prisma from '../prisma';
import { loadConfig } from '../config';

const sendPushSchema = z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
});

export default async function internalPushRoutes(fastify: FastifyInstance) {
    fastify.post('/send', async (request, reply) => {
        const { userId, title, body, data } = sendPushSchema.parse(request.body);

        // Fetch tokens from UserService via the new AuthSubject ID endpoint
        const config = loadConfig();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (config.SERVICE_AUTH_TOKEN) {
            headers['x-service-token'] = config.SERVICE_AUTH_TOKEN;
        }

        const userSvcUrl = config.USER_SERVICE_URL;
        const resp = await fetch(`${userSvcUrl}/internal/users/fcm-tokens-by-auth-id`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ authIds: [userId] }),
        });

        if (!resp.ok) {
            console.error(`[internal-push] Failed to fetch FCM tokens from UserService for userId: ${userId}, status: ${resp.status}`);
            return reply.send({ success: false, reason: 'user_service_error' });
        }

        const json = await resp.json() as { tokens: { userId: string, fcmToken: string, deviceId: string }[] };
        const fcmTokens = json.tokens || [];

        if (fcmTokens.length === 0) {
            return reply.send({ success: true, skipped: true, reason: 'no_tokens' });
        }

        const tokens = fcmTokens.map(t => t.fcmToken);
        const result = await pushNotificationService.sendToMultipleDevices(tokens, { title, body, data });

        await prisma.notification.create({
            data: {
                userId,
                type: 'PUSH',
                title,
                body,
                data,
                status: result.successCount > 0 ? 'SENT' : 'FAILED',
                fcmMessageId: result.responses.find(r => r.messageId)?.messageId,
                fcmError: result.failureCount > 0 ? JSON.stringify(result.responses.filter(r => r.error)) : undefined,
            },
        });

        return reply.send({
            success: true,
            successCount: result.successCount,
            failureCount: result.failureCount,
        });
    });
}
