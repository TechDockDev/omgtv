import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushNotificationService } from '../services/PushNotificationService';
import prisma from '../prisma';

const sendPushSchema = z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    imageUrl: z.string().url().optional(),
});

const registerTokenSchema = z.object({
    userId: z.string().uuid(),
    token: z.string().min(1),
    deviceId: z.string().optional(),
    platform: z.enum(['ios', 'android', 'web']).optional(),
});

const sendTopicPushSchema = z.object({
    topic: z.string().min(1),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    imageUrl: z.string().url().optional(),
});

export default async function pushRoutes(fastify: FastifyInstance) {
    /**
     * POST /push/send
     * Send push notification to a specific user (all their devices)
     */
    fastify.post('/send', {
        schema: {
            body: sendPushSchema,
        },
    }, async (request, reply) => {
        const { userId, title, body, data, imageUrl } = sendPushSchema.parse(request.body);

        try {
            // Get all FCM tokens for this user
            const fcmTokens = await prisma.fcmToken.findMany({
                where: { userId },
            });

            if (fcmTokens.length === 0) {
                return reply.code(404).send({
                    success: false,
                    error: 'No FCM tokens found for this user',
                });
            }

            const tokens = fcmTokens.map((t: { token: string }) => t.token);

            // Send push notification
            const result = await pushNotificationService.sendToMultipleDevices(tokens, {
                title,
                body,
                data,
                imageUrl,
            });

            // Log notification in database
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
        } catch (error) {
            fastify.log.error(error, 'Failed to send push notification');
            return reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to send push',
            });
        }
    });

    /**
     * POST /push/topic
     * Send push notification to a topic
     */
    fastify.post('/topic', {
        schema: {
            body: sendTopicPushSchema,
        },
    }, async (request, reply) => {
        const { topic, title, body, data, imageUrl } = sendTopicPushSchema.parse(request.body);

        try {
            const result = await pushNotificationService.sendToTopic(topic, {
                title,
                body,
                data,
                imageUrl,
            });

            return reply.send({
                success: result.success,
                messageId: result.messageId,
                error: result.error,
            });
        } catch (error) {
            fastify.log.error(error, 'Failed to send topic push');
            return reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to send topic push',
            });
        }
    });

    /**
     * POST /push/register-token
     * Register FCM token for a user
     */
    fastify.post('/register-token', {
        schema: {
            body: registerTokenSchema,
        },
    }, async (request, reply) => {
        const { userId, token, deviceId, platform } = registerTokenSchema.parse(request.body);

        try {
            // Upsert FCM token (update if exists, create if not)
            const fcmToken = await prisma.fcmToken.upsert({
                where: { token },
                update: {
                    userId,
                    deviceId,
                    platform,
                    lastUsed: new Date(),
                },
                create: {
                    userId,
                    token,
                    deviceId,
                    platform,
                },
            });

            console.log("registered device", fcmToken)

            return reply.send({
                success: true,
                tokenId: fcmToken.id,
            });
        } catch (error) {
            fastify.log.error(error, 'Failed to register FCM token');
            return reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to register token',
            });
        }
    });

    /**
     * DELETE /push/unregister-token
     * Unregister FCM token
     */
    fastify.delete('/unregister-token', {
        schema: {
            body: z.object({
                token: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { token } = z.object({ token: z.string() }).parse(request.body);

        try {
            await prisma.fcmToken.delete({
                where: { token },
            });

            return reply.send({
                success: true,
            });
        } catch (error) {
            fastify.log.error(error, 'Failed to unregister FCM token');
            return reply.code(404).send({
                success: false,
                error: 'Token not found',
            });
        }
    });

    /**
     * GET /push/tokens/:userId
     * Get all FCM tokens for a user
     */
    fastify.get('/tokens/:userId', async (request, reply) => {
        const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);

        try {
            const tokens = await prisma.fcmToken.findMany({
                where: { userId },
            });

            return reply.send({
                success: true,
                tokens,
            });
        } catch (error) {
            fastify.log.error(error, 'Failed to fetch FCM tokens');
            return reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch tokens',
            });
        }
    });
}
