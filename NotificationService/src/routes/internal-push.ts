import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushNotificationService } from '../services/PushNotificationService';
import prisma from '../prisma';

const sendPushSchema = z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
});

export default async function internalPushRoutes(fastify: FastifyInstance) {
    fastify.post('/send', async (request, reply) => {
        const { userId, title, body, data } = sendPushSchema.parse(request.body);

        const fcmTokens = await prisma.fcmToken.findMany({ where: { userId } });

        if (fcmTokens.length === 0) {
            return reply.send({ success: true, skipped: true, reason: 'no_tokens' });
        }

        const tokens = fcmTokens.map((t: { token: string }) => t.token);
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
