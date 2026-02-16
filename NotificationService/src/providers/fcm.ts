import { getMessaging } from 'firebase-admin/messaging';
import { PushPayload, PushProvider } from './interfaces';
import { initializeFirebase, isFirebaseAvailable } from '../config/firebase';
import { NotificationType } from '@prisma/client';
import type { Messaging } from 'firebase-admin/messaging';

export class FcmProvider implements PushProvider {
    type: 'PUSH' = 'PUSH';
    private messaging: Messaging | null = null;

    private ensureInitialized(): Messaging {
        if (this.messaging) return this.messaging;

        if (!isFirebaseAvailable()) {
            initializeFirebase();
        }

        if (!isFirebaseAvailable()) {
            throw new Error('Firebase is not available — push notifications cannot be sent. Check Firebase credentials.');
        }

        this.messaging = getMessaging();
        return this.messaging;
    }

    async send(payload: PushPayload): Promise<{ messageId: string }> {
        try {
            const messaging = this.ensureInitialized();
            const messageId = await messaging.send({
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
