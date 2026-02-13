import { getMessaging } from 'firebase-admin/messaging';
import { PushPayload, PushProvider } from './interfaces';
import { initializeFirebase } from '../config/firebase';
import { NotificationType } from '@prisma/client';

export class FcmProvider implements PushProvider {
    type: 'PUSH' = 'PUSH';
    private messaging;

    constructor() {
        initializeFirebase();
        this.messaging = getMessaging();
    }

    async send(payload: PushPayload): Promise<{ messageId: string }> {
        try {
            const messageId = await this.messaging.send({
                token: payload.token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                    imageUrl: payload.imageUrl,
                },
                data: payload.data,
            });

            return { messageId };
        } catch (error) {
            console.error('FCM Send Error:', error);
            throw error;
        }
    }
}
