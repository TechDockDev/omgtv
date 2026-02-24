import prisma from '../prisma';
import { Notification, NotificationStatus, NotificationType, Prisma } from '@prisma/client';

export type CreateNotificationInput = Prisma.NotificationCreateInput;

export const NotificationRepository = {
    create: async (data: CreateNotificationInput) => {
        return prisma.notification.create({ data });
    },

    findById: async (id: string) => {
        return prisma.notification.findUnique({ where: { id } });
    },

    updateStatus: async (id: string, status: NotificationStatus, error?: string) => {
        return prisma.notification.update({
            where: { id },
            data: {
                status,
                error: error || null
            },
        });
    },

    findPending: async (limit = 100) => {
        return prisma.notification.findMany({
            where: { status: 'PENDING' },
            orderBy: { priority: 'asc' }, // Process HIGH/CRITICAL first if enum is ordered appropriately, otherwise needs specific sort
            take: limit,
        });
    },

    findByUser: async (userId: string, limit = 20, offset = 0) => {
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        });

        // Global Auto-read: Update ALL notifications for this user that are not yet READ
        await prisma.notification.updateMany({
            where: {
                userId,
                status: { in: [NotificationStatus.SENT, NotificationStatus.PENDING] }
            },
            data: { status: NotificationStatus.READ }
        });

        // Return the fetched notifications but marked as READ in-memory so the response is consistent
        return notifications.map(n => ({
            ...n,
            status: NotificationStatus.READ
        }));
    },

    countUnread: async (userId: string) => {
        return prisma.notification.count({
            where: {
                userId,
                status: 'SENT' // Changed from PENDING since created notifications are immediately marked SENT
            }
        });
    },

    markAllAsRead: async (userId: string) => {
        return prisma.notification.updateMany({
            where: {
                userId,
                status: 'SENT'
            },
            data: {
                status: NotificationStatus.READ
            }
        });
    }
};
