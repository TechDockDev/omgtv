import { CampaignRepository, CreateCampaignInput } from '../repositories/campaign';
import { pushNotificationService } from './PushNotificationService';
import { PreferenceRepository } from '../repositories/preference';
import prisma from '../prisma';
import { NotificationType, CampaignStatus, UserNotificationPreference } from '@prisma/client';

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

        // 2. Atomic claim if SCHEDULED
        if (campaign.status === 'SCHEDULED') {
            const claimed = await CampaignRepository.claimForProcessing(id);
            if (!claimed) {
                console.log(`Campaign ${id} already claimed by another instance.`);
                return { success: true, claimedByOther: true };
            }
        } else if (campaign.status === 'COMPLETED' || campaign.status === 'SENDING') {
            console.log(`Campaign ${id} already processed or in progress. Status: ${campaign.status}`);
            return { success: true, status: campaign.status };
        } else {
            // DRAFT or other manual triggers
            await CampaignRepository.updateStatus(id, 'SENDING');
        }

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

                // Fetch preferences for the batch to respect user opt-outs
                const preferences: UserNotificationPreference[] = await PreferenceRepository.getBatch(batchUserIds);
                const prefMap = new Map<string, UserNotificationPreference>(preferences.map(p => [p.userId, p]));

                // A. Handle PUSH
                if (campaign.type === 'PUSH') {
                    // Filter out users who have push disabled (default to enabled if no record)
                    const allowedPushUserIds = batchUserIds.filter(uid => prefMap.get(uid)?.pushEnabled !== false);

                    if (allowedPushUserIds.length > 0) {
                        const fcmTokenEntries = await userProvider.getFcmTokensForUsers(allowedPushUserIds);

                        if (fcmTokenEntries.length > 0) {
                            // De-duplicate tokens to ensure one push per unique token for this campaign
                            const uniqueTokens = [...new Set(fcmTokenEntries.map(t => t.fcmToken))];

                            const result = await pushNotificationService.sendToMultipleDevices(uniqueTokens, {
                                title: campaign.title,
                                body: campaign.body,
                                data: (campaign.data as any) || {}
                            });

                            totalSent += result.successCount;
                            totalFailed += result.failureCount;

                            // Create Notification Records for PUSH history
                            // Map back to users - note: multiple tokens might exist for one user
                            const notificationsData = fcmTokenEntries.map((t) => {
                                // Find if this token was successful in the bulk result
                                // Note: sendEachForMulticast returns responses in same order as tokens
                                const tokenIdx = uniqueTokens.indexOf(t.fcmToken);
                                const resp = result.responses[tokenIdx];

                                return {
                                    userId: t.userId,
                                    type: NotificationType.PUSH,
                                    title: campaign.title,
                                    body: campaign.body,
                                    data: campaign.data || {},
                                    status: resp?.success ? 'SENT' : 'FAILED',
                                    campaignId: campaign.id,
                                    fcmMessageId: resp?.messageId,
                                    fcmError: resp?.error
                                } as any;
                            });

                            await prisma.notification.createMany({ data: notificationsData });
                        }
                    }
                }

                // B. Handle IN_APP
                if (campaign.type === 'IN_APP') {
                    // Filter out users who have in-app disabled
                    const allowedInAppUserIds = batchUserIds.filter(uid => prefMap.get(uid)?.inAppEnabled !== false);

                    if (allowedInAppUserIds.length > 0) {
                        const notificationsData = allowedInAppUserIds.map(userId => ({
                            userId,
                            type: NotificationType.IN_APP,
                            title: campaign.title,
                            body: campaign.body,
                            data: campaign.data || {},
                            status: 'SENT',
                            campaignId: campaign.id,
                            priority: 'MEDIUM'
                        } as any));

                        await prisma.notification.createMany({ data: notificationsData });
                        totalSent += allowedInAppUserIds.length;
                    }
                }

                // C. Handle EMAIL
                if (campaign.type === 'EMAIL') {
                    // Filter out users who have email disabled
                    const allowedEmailUserIds = batchUserIds.filter(uid => prefMap.get(uid)?.emailEnabled !== false);

                    if (allowedEmailUserIds.length > 0) {
                        const profiles = await userProvider.getUserProfiles(allowedEmailUserIds);
                        const { NotificationManager } = await import('./notification-manager');
                        const manager = new NotificationManager();

                        await Promise.all(allowedEmailUserIds.map(async (userId) => {
                            const profile = profiles[userId];
                            if (profile && profile.email) {
                                try {
                                    await manager.sendDirectEmail(profile.email, campaign.title, campaign.body);

                                    // Record the notification
                                    await prisma.notification.create({
                                        data: {
                                            userId,
                                            type: NotificationType.EMAIL,
                                            title: campaign.title,
                                            body: campaign.body,
                                            data: campaign.data || {},
                                            status: 'SENT',
                                            campaignId: campaign.id,
                                            priority: 'MEDIUM'
                                        }
                                    });
                                    totalSent++;
                                } catch (err) {
                                    console.error(`Failed to send campaign email to ${profile.email}:`, err);
                                    totalFailed++;
                                }
                            } else {
                                console.warn(`Skipping campaign email for user ${userId} — no email address found`);
                                totalFailed++;
                            }
                        }));
                    }
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
