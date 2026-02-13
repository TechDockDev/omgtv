import { getMessaging } from '../config/firebase';
import type { Message, BatchResponse, MulticastMessage } from 'firebase-admin/messaging';

export interface PushNotificationPayload {
    title: string;
    body: string;
    data?: { [key: string]: string };
    imageUrl?: string;
}

export interface SendPushResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

export interface BulkPushResult {
    successCount: number;
    failureCount: number;
    responses: SendPushResult[];
}

export class PushNotificationService {
    /**
     * Send push notification to a single device
     */
    async sendToDevice(
        deviceToken: string,
        notification: PushNotificationPayload
    ): Promise<SendPushResult> {
        try {
            const messaging = getMessaging();

            const message: Message = {
                token: deviceToken,
                notification: {
                    title: notification.title,
                    body: notification.body,
                    ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
                },
                ...(notification.data && { data: notification.data }),
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        priority: 'high',
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                        },
                    },
                },
            };

            const messageId = await messaging.send(message);

            console.log(`✅ Push notification sent successfully: ${messageId}`);
            return { success: true, messageId };
        } catch (error: any) {
            console.error('❌ Failed to send push notification:', error);
            const errorCode = error.code || 'unknown';
            const errorMessage = error.message || 'Unknown error';
            console.error(`Firebase Error Code: ${errorCode}`);
            return { success: false, error: `${errorCode}: ${errorMessage}` };
        }
    }

    /**
     * Send push notifications to multiple devices with automatic batching (500 tokens limit)
     */
    async sendToMultipleDevices(
        deviceTokens: string[],
        notification: PushNotificationPayload,
        maxRetries = 3
    ): Promise<BulkPushResult> {
        const BATCH_SIZE = 500;
        let successCount = 0;
        let failureCount = 0;
        const allResponses: SendPushResult[] = [];

        // Split tokens into batches of 500 (FCM limit)
        for (let i = 0; i < deviceTokens.length; i += BATCH_SIZE) {
            const batchTokens = deviceTokens.slice(i, i + BATCH_SIZE);

            let retryCount = 0;
            let success = false;
            let batchResponse: BulkPushResult | null = null;

            while (retryCount <= maxRetries && !success) {
                try {
                    batchResponse = await this.sendBatch(batchTokens, notification);
                    success = true;
                } catch (error: any) {
                    const isTransient = error.code === 'messaging/server-unavailable' || error.code === 'messaging/internal-error';
                    if (isTransient && retryCount < maxRetries) {
                        retryCount++;
                        const delay = Math.pow(2, retryCount) * 1000;
                        console.warn(`Transient FCM error, retrying batch (${retryCount}/${maxRetries}) after ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        console.error('Final FCM batch failure:', error);
                        failureCount += batchTokens.length;
                        batchTokens.forEach(() => {
                            allResponses.push({ success: false, error: error.message });
                        });
                        break;
                    }
                }
            }

            if (batchResponse) {
                successCount += batchResponse.successCount;
                failureCount += batchResponse.failureCount;
                allResponses.push(...batchResponse.responses);
            }
        }

        return {
            successCount,
            failureCount,
            responses: allResponses,
        };
    }

    /**
     * Internal method to send a single batch of up to 500 tokens
     */
    private async sendBatch(
        tokens: string[],
        notification: PushNotificationPayload
    ): Promise<BulkPushResult> {
        const messaging = getMessaging();

        const message: MulticastMessage = {
            tokens: tokens,
            notification: {
                title: notification.title,
                body: notification.body,
                ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
            },
            ...(notification.data && { data: notification.data }),
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    priority: 'high',
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                    },
                },
            },
        };

        const response: BatchResponse = await messaging.sendEachForMulticast(message);

        const results: SendPushResult[] = response.responses.map((resp, idx) => {
            if (resp.success) {
                return { success: true, messageId: resp.messageId };
            } else {
                const errorCode = (resp.error as any)?.code || 'unknown';
                const errorMessage = resp.error?.message || 'Unknown error';
                console.error(`❌ Token index ${idx} failed: [${errorCode}] ${errorMessage}`);
                return {
                    success: false,
                    error: `${errorCode}: ${errorMessage}`
                };
            }
        });

        return {
            successCount: response.successCount,
            failureCount: response.failureCount,
            responses: results,
        };
    }
    /**
     * Send push notification to a topic
     */
    async sendToTopic(
        topic: string,
        notification: PushNotificationPayload
    ): Promise<SendPushResult> {
        try {
            const messaging = getMessaging();

            const message: Message = {
                topic,
                notification: {
                    title: notification.title,
                    body: notification.body,
                    ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
                },
                ...(notification.data && { data: notification.data }),
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        priority: 'high',
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                        },
                    },
                },
            };

            const messageId = await messaging.send(message);

            console.log(`✅ Push notification sent to topic "${topic}": ${messageId}`);
            return { success: true, messageId };
        } catch (error) {
            console.error(`❌ Failed to send push to topic "${topic}":`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Subscribe devices to a topic
     */
    async subscribeToTopic(deviceTokens: string[], topic: string): Promise<void> {
        try {
            const messaging = getMessaging();
            await messaging.subscribeToTopic(deviceTokens, topic);
            console.log(`✅ Subscribed ${deviceTokens.length} devices to topic "${topic}"`);
        } catch (error) {
            console.error(`❌ Failed to subscribe to topic "${topic}":`, error);
            throw error;
        }
    }

    /**
     * Unsubscribe devices from a topic
     */
    async unsubscribeFromTopic(deviceTokens: string[], topic: string): Promise<void> {
        try {
            const messaging = getMessaging();
            await messaging.unsubscribeFromTopic(deviceTokens, topic);
            console.log(`✅ Unsubscribed ${deviceTokens.length} devices from topic "${topic}"`);
        } catch (error) {
            console.error(`❌ Failed to unsubscribe from topic "${topic}":`, error);
            throw error;
        }
    }
}

export const pushNotificationService = new PushNotificationService();
