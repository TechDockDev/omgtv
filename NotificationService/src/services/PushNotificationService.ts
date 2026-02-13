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
     * Send push notifications to multiple devices
     */
    async sendToMultipleDevices(
        deviceTokens: string[],
        notification: PushNotificationPayload
    ): Promise<BulkPushResult> {
        try {
            const messaging = getMessaging();

            const message: MulticastMessage = {
                tokens: deviceTokens,
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

            console.log("message", message)
            const response: BatchResponse = await messaging.sendEachForMulticast(message);
            console.log("response", response)
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

            console.log(`✅ Bulk push sent: ${response.successCount} success, ${response.failureCount} failures`);

            return {
                successCount: response.successCount,
                failureCount: response.failureCount,
                responses: results,
            };
        } catch (error) {
            console.error('❌ Failed to send bulk push notifications:', error);
            throw error;
        }
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
