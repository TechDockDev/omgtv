import prisma from '../prisma';
import { Campaign, CampaignStatus, Prisma } from '@prisma/client';

export type CreateCampaignInput = Prisma.CampaignCreateInput;

export const CampaignRepository = {
    create: async (data: CreateCampaignInput) => {
        return prisma.campaign.create({ data });
    },

    findById: async (id: string) => {
        return prisma.campaign.findUnique({
            where: { id },
            include: {
                _count: {
                    select: { notifications: true }
                }
            }
        });
    },

    findByIdempotencyKey: async (idempotencyKey: string) => {
        return prisma.campaign.findUnique({
            where: { idempotencyKey }
        });
    },
    update: async (id: string, data: Prisma.CampaignUpdateInput) => {
        return prisma.campaign.update({
            where: { id },
            data
        });
    },

    updateStatus: async (id: string, status: CampaignStatus) => {
        return prisma.campaign.update({
            where: { id },
            data: { status }
        });
    },

    list: async (limit = 10, offset = 0) => {
        return prisma.campaign.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset
        });
    },

    findScheduled: async () => {
        return prisma.campaign.findMany({
            where: {
                status: 'SCHEDULED',
                scheduledAt: {
                    lte: new Date()
                }
            }
        });
    },

    incrementStats: async (id: string, sentCount: number, failedCount: number) => {
        return prisma.campaign.update({
            where: { id },
            data: {
                sentCount: { increment: sentCount },
                failedCount: { increment: failedCount }
            }
        });
    },

    delete: async (id: string) => {
        // Delete associated notifications first, then the campaign
        await prisma.notification.deleteMany({ where: { campaignId: id } });
        return prisma.campaign.delete({ where: { id } });
    },

    findNotifications: async (campaignId: string, opts: { status?: string; limit?: number; offset?: number } = {}) => {
        const where: any = { campaignId };
        if (opts.status) where.status = opts.status;

        const [notifications, total] = await Promise.all([
            prisma.notification.findMany({
                where,
                select: {
                    id: true,
                    userId: true,
                    status: true,
                    fcmError: true,
                    fcmMessageId: true,
                    createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: opts.limit ?? 20,
                skip: opts.offset ?? 0,
            }),
            prisma.notification.count({ where }),
        ]);

        return { notifications, total };
    },
};
