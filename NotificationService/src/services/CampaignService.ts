import { CampaignRepository, CreateCampaignInput } from '../repositories/campaign';
import { pushNotificationService } from './PushNotificationService';
import prisma from '../prisma';
import { NotificationType, CampaignStatus } from '@prisma/client';

import { userProvider } from '../providers/UserProvider';

export class CampaignService {
    /**
     * Create a new campaign
     */
    async createCampaign(input: CreateCampaignInput) {
        return CampaignRepository.create(input);
    }

    /**
     * Get campaign details and stats
     */
    async getCampaign(id: string) {
        return CampaignRepository.findById(id);
    }

    /**
     * List campaigns
     */
    async listCampaigns(limit?: number, offset?: number) {
        return CampaignRepository.list(limit, offset);
    }

    /**
     * Trigger a campaign execution with batching and idempotency
     */
    async executeCampaign(id: string, idempotencyKey?: string) {
        // 1. Idempotency Check
        if (idempotencyKey) {
            const existing = await CampaignRepository.findByIdempotencyKey(idempotencyKey);
            if (existing && existing.id !== id) {
                console.log(`Idempotency key ${idempotencyKey} already used by campaign ${existing.id}`);
                return { success: true, alreadyExecuted: true };
            }
        }

        const campaign = await CampaignRepository.findById(id);
        if (!campaign) throw new Error('Campaign not found');

        if (campaign.status === 'COMPLETED' || campaign.status === 'SENDING') {
            console.log(`Campaign ${id} already processed or in progress. Status: ${campaign.status}`);
            return { success: true, status: campaign.status };
        }

        // 2. Update status to SENDING
        await CampaignRepository.updateStatus(id, 'SENDING');

        try {
            // 3. Resolve Target Users
            let targetUserIds: string[] = [];
            const criteria = (campaign.targetCriteria as any) || {};

            if (criteria.segment === 'SUBSCRIBERS') {
                targetUserIds = await userProvider.getActiveSubscribers();
            } else if (criteria.segment === 'ALL') {
                // For ALL, we might want to optimize, but for now let's fetch all IDs to ensure In-App consistency
                // Or maybe we treat ALL differently.
                // If it's PUSH only and ALL, the old logic was fine.
                // But for IN_APP, we need IDs.
                // Let's assume 'ALL' fetches from UserService without filters.
                targetUserIds = await userProvider.getUsersByCriteria({});
            } else if (Object.keys(criteria).length > 0) {
                // Custom filters
                targetUserIds = await userProvider.getUsersByCriteria(criteria);
            } else {
                // Default to ALL if no criteria? Or fail?
                // Provide safe fallback: if no criteria, maybe it WAS meant for everyone?
                targetUserIds = await userProvider.getUsersByCriteria({});
            }

            console.log(`Campaign ${id}: Resolved ${targetUserIds.length} target users.`);

            const BATCH_SIZE = 500;
            let totalSent = 0;
            let totalFailed = 0;

            // 4. Process in Batches
            for (let i = 0; i < targetUserIds.length; i += BATCH_SIZE) {
                const batchUserIds = targetUserIds.slice(i, i + BATCH_SIZE);

                // A. Handle PUSH
                if (campaign.type === 'PUSH') {
                    const fcmTokens = await prisma.fcmToken.findMany({
                        where: { userId: { in: batchUserIds } },
                        select: { token: true, userId: true }
                    });

                    if (fcmTokens.length > 0) {
                        const tokens = fcmTokens.map(t => t.token);
                        const result = await pushNotificationService.sendToMultipleDevices(tokens, {
                            title: campaign.title,
                            body: campaign.body,
                            data: (campaign.data as any) || {}
                        });

                        totalSent += result.successCount;
                        totalFailed += result.failureCount;

                        // Create Notification Records for PUSH history
                        const notificationsData = fcmTokens.map((t, idx) => {
                            const resp = result.responses[idx];
                            return {
                                userId: t.userId,
                                type: NotificationType.PUSH,
                                title: campaign.title,
                                body: campaign.body,
                                data: campaign.data || {},
                                status: resp.success ? 'SENT' : 'FAILED',
                                campaignId: campaign.id,
                                fcmMessageId: resp.messageId,
                                fcmError: resp.error
                            } as any;
                        });

                        await prisma.notification.createMany({ data: notificationsData });
                    }
                }

                // B. Handle IN_APP
                if (campaign.type === 'IN_APP') {
                    const notificationsData = batchUserIds.map(userId => ({
                        userId,
                        type: NotificationType.IN_APP,
                        title: campaign.title,
                        body: campaign.body,
                        data: campaign.data || {},
                        status: 'SENT', // In-App is "Sent" as soon as DB record exists
                        campaignId: campaign.id,
                        priority: 'MEDIUM' // Could come from campaign
                    } as any));

                    await prisma.notification.createMany({ data: notificationsData });
                    totalSent += batchUserIds.length;
                }
            }

            await CampaignRepository.updateStatus(id, 'COMPLETED');
            await CampaignRepository.incrementStats(id, totalSent, totalFailed);

            return { success: true, sent: totalSent, failed: totalFailed };

        } catch (error) {
            console.error(`Failed to execute campaign ${id}:`, error);
            await CampaignRepository.updateStatus(id, 'FAILED');
            throw error;
        }
    }
    /**
     * Process scheduled campaigns
     */
    async processScheduledCampaigns() {
        const campaigns = await CampaignRepository.findScheduled();
        console.log(`Checking for scheduled campaigns... Found ${campaigns.length}`);

        for (const campaign of campaigns) {
            console.log(`Triggering scheduled campaign: ${campaign.name} (${campaign.id})`);
            await this.executeCampaign(campaign.id).catch(err => {
                console.error(`Error processing scheduled campaign ${campaign.id}:`, err);
            });
        }
    }
}

export const campaignService = new CampaignService();
