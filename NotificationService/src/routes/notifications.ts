import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotificationRepository } from '../repositories/notification';
import { NotificationStatus } from '@prisma/client';
import prisma from '../prisma';

export default async function notificationRoutes(server: FastifyInstance) {
    // All routes in this module require authentication
    server.addHook('onRequest', server.authenticate);

    // GET /notifications
    server.get('/', {
        schema: {
            querystring: z.object({
                limit: z.coerce.number().default(20),
                offset: z.coerce.number().default(0),
            }),
        }
    }, async (request) => {
        const userId = request.user!.id;
        console.log("userid", userId);
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
        const userId = request.user!.id;
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
    server.get('/unread-count', async (request) => {
        const userId = request.user!.id;
        const count = await NotificationRepository.countUnread(userId);
        return { count };
    });

    // PATCH /notifications/read-all
    server.patch('/read-all', async (request) => {
        const userId = request.user!.id;
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
        const userId = request.user!.id;
        const { id } = request.params as { id: string };
        const notification = await NotificationRepository.findById(id);

        if (!notification) {
            return reply.status(404).send({ error: 'Notification not found' });
        }

        if (notification.userId !== userId) {
            return reply.status(403).send({ error: 'Forbidden' });
        }

        await prisma.notification.delete({ where: { id } });
        return { success: true };
    });
}
