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
    }
};
