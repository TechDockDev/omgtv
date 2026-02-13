import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotificationRepository } from '../repositories/notification';
import { NotificationStatus } from '@prisma/client';
import prisma from '../prisma';

export default async function notificationRoutes(server: FastifyInstance) {
    // GET /notifications
    server.get('/', {
        schema: {
            querystring: z.object({
                limit: z.coerce.number().default(20),
                offset: z.coerce.number().default(0),
            }),
        }
    }, async (request, reply) => {
        // In a real scenario, userId would be extracted from the request token (middleware)
        // For this MVP, we might expect it in headers or assume a mechanism exists.
        // Let's assume it's passed in header 'x-user-id' for now since we don't have full Auth middleware here.
        const userId = request.headers['x-user-id'] as string;

        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const { limit, offset } = request.query as { limit: number; offset: number };
        const notifications = await NotificationRepository.findByUser(userId, limit, offset);

        return { notifications };
    });

    // PATCH /notifications/:id/read
    server.patch('/:id/read', {
        schema: {
            params: z.object({
                id: z.string(),
            }),
        }
    }, async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;
        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const { id } = request.params as { id: string };
        const notification = await NotificationRepository.findById(id);

        if (!notification) {
            return reply.status(404).send({ error: 'Notification not found' });
        }

        if (notification.userId !== userId) {
            return reply.status(403).send({ error: 'Forbidden' });
        }

        const updated = await NotificationRepository.updateStatus(id, NotificationStatus.READ);
        return updated;
    });

    // GET /notifications/unread-count
    server.get('/unread-count', async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;
        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const count = await NotificationRepository.countUnread(userId);
        return { count };
    });

    // PATCH /notifications/read-all
    server.patch('/read-all', async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;
        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const result = await NotificationRepository.markAllAsRead(userId);
        return { success: true, count: result.count };
    });

    // DELETE /notifications/:id
    server.delete('/:id', {
        schema: {
            params: z.object({
                id: z.string(),
            }),
        }
    }, async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;
        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const { id } = request.params as { id: string };
        const notification = await NotificationRepository.findById(id);

        if (!notification) {
            return reply.status(404).send({ error: 'Notification not found' });
        }

        if (notification.userId !== userId) {
            return reply.status(403).send({ error: 'Forbidden' });
        }

        // Hard delete for now, or could soft delete if status changed
        await prisma.notification.delete({ where: { id } });
        return { success: true };
    });
}
