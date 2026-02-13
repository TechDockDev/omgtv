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
        return prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        });
    },

    countUnread: async (userId: string) => {
        return prisma.notification.count({
            where: {
                userId,
                status: 'PENDING' // Assuming PENDING matches unread logic, or we change status enum to include UNREAD
            }
        });
    },

    markAllAsRead: async (userId: string) => {
        return prisma.notification.updateMany({
            where: {
                userId,
                status: 'PENDING'
            },
            data: {
                status: NotificationStatus.READ
            }
        });
    }
};
