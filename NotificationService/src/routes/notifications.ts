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
        const customerId = request.user!.customerId;
        const { limit, offset } = request.query as { limit: number; offset: number };
        const notifications = await NotificationRepository.findByUser(customerId, limit, offset);

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const grouped = {
            today: [] as typeof notifications,
            yesterday: [] as typeof notifications,
            others: [] as typeof notifications
        };

        notifications.forEach(n => {
            const date = new Date(n.createdAt);
            if (date >= today) {
                grouped.today.push(n);
            } else if (date >= yesterday) {
                grouped.yesterday.push(n);
            } else {
                grouped.others.push(n);
            }
        });

        return grouped;
    });

    // PATCH /notifications/:id/read
    server.patch('/:id/read', {
        schema: {
            params: z.object({
                id: z.string(),
            }),
        }
    }, async (request, reply) => {
        const customerId = request.user!.customerId;
        const { id } = request.params as { id: string };
        const notification = await NotificationRepository.findById(id);

        if (!notification) {
            return reply.status(404).send({ error: 'Notification not found' });
        }

        if (notification.userId !== customerId) {
            return reply.status(403).send({ error: 'Forbidden' });
        }

        const updated = await NotificationRepository.updateStatus(id, NotificationStatus.READ);
        return updated;
    });

    // GET /notifications/unread-count
    server.get('/unread-count', async (request) => {
        const userId = request.user!.id;
        const customerId = request.user!.customerId;
        const count = await NotificationRepository.countUnread(customerId);
        return { count };
    });

    // PATCH /notifications/read-all
    server.patch('/read-all', async (request) => {
        const userId = request.user!.id;
        const customerId = request.user!.customerId;
        const result = await NotificationRepository.markAllAsRead(customerId);
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
        const customerId = request.user!.customerId;
        const { id } = request.params as { id: string };
        const notification = await NotificationRepository.findById(id);

        if (!notification) {
            return reply.status(404).send({ error: 'Notification not found' });
        }

        if (notification.userId !== customerId) {
            return reply.status(403).send({ error: 'Forbidden' });
        }

        await prisma.notification.delete({ where: { id } });
        return { success: true };
    });
}
