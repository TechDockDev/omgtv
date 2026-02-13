import { CampaignRepository, CreateCampaignInput } from '../repositories/campaign';
import { pushNotificationService } from './PushNotificationService';
import prisma from '../prisma';
import { NotificationType, CampaignStatus } from '@prisma/client';

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

        const BATCH_SIZE = 500;
        let totalSent = 0;
        let totalFailed = 0;
        let offset = 0;

        try {
            if (campaign.type === 'PUSH') {
                while (true) {
                    // 3. Fetch Tokens in Batches
                    const fcmTokens = await prisma.fcmToken.findMany({
                        select: { token: true, userId: true },
                        take: BATCH_SIZE,
                        skip: offset
                    });

                    if (fcmTokens.length === 0) break;

                    const tokens = fcmTokens.map(t => t.token);

                    // 4. Dispatch Push Batch
                    const result = await pushNotificationService.sendToMultipleDevices(tokens, {
                        title: campaign.title,
                        body: campaign.body,
                        data: (campaign.data as any) || {}
                    });

                    // 5. Update Campaign Stats Incrementally
                    await CampaignRepository.incrementStats(id, result.successCount, result.failureCount);
                    totalSent += result.successCount;
                    totalFailed += result.failureCount;

                    // 6. Create Notification Records for the batch
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

                    await prisma.notification.createMany({
                        data: notificationsData
                    });

                    offset += BATCH_SIZE;
                    // Optional: Sleep briefly between batches to prevent DB/FCM overload
                    // await new Promise(resolve => setTimeout(resolve, 50));
                }

                await CampaignRepository.updateStatus(id, 'COMPLETED');
                return { success: true, sent: totalSent, failed: totalFailed };
            }

            // TODO: Support EMAIL and IN_APP campaign execution
            await CampaignRepository.updateStatus(id, 'COMPLETED');
            return { success: true, sent: 0, failed: 0 };

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
