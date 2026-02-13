import { NotificationType, NotificationStatus } from '@prisma/client';
import { NotificationRepository } from '../repositories/notification';
import { PreferenceRepository } from '../repositories/preference';
import { FcmProvider } from '../providers/fcm';
import { ConsoleEmailProvider } from '../providers/email';
import { EmailPayload, PushPayload } from '../providers/interfaces';

export class NotificationManager {
    private emailProvider: ConsoleEmailProvider;
    private pushProvider: FcmProvider;

    constructor() {
        this.emailProvider = new ConsoleEmailProvider();
        this.pushProvider = new FcmProvider();
    }

    async sendNotification(
        userId: string,
        type: NotificationType,
        title: string,
        body: string,
        payload?: Record<string, any>,
        priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM'
    ) {
        // 1. Check Preferences
        const prefs = await PreferenceRepository.get(userId);

        let isAllowed = false;
        switch (type) {
            case 'EMAIL':
                isAllowed = prefs.emailEnabled;
                break;
            case 'PUSH':
                isAllowed = prefs.pushEnabled;
                break;
            case 'IN_APP':
                isAllowed = prefs.inAppEnabled;
                break;
        }

        if (!isAllowed) {
            console.log(`Notification blocked by user preference: User ${userId}, Type ${type}`);
            return;
        }

        // 2. Persist Notification
        const notification = await NotificationRepository.create({
            userId,
            type,
            title,
            body,
            data: payload || {},
            status: NotificationStatus.PENDING,
            priority
        });

        // 3. Dispatch to Provider
        try {
            if (type === 'EMAIL') {
                const emailPayload: EmailPayload = {
                    to: 'user-email@example.com', // TODO: Fetch user email from User Service
                    subject: title,
                    html: body,
                    text: body
                };
                // In a real scenario, we'd need the user's email address here. 
                // We might need to fetch it from UserService via gRPC if it's not passed in.

                await this.emailProvider.send(emailPayload);
            } else if (type === 'PUSH') {
                // We need the user's FCM token. 
                // This usually implies looking up the user's active sessions or device tokens.
                // For now, assuming the token might be passed in payload or we need a way to fetch it.
                // Let's assume for this MVP that 'payload' contains a 'token' if it's a direct push, 
                // OR we have a device token stored in a Device/Session table (which we don't have access to directly here).

                // TODO: Integrate with User/Auth service to get device tokens
                const token = payload?.token;
                if (token) {
                    await this.pushProvider.send({
                        token,
                        title,
                        body,
                        data: payload as any
                    });
                }
            }

            // 4. Update Status
            await NotificationRepository.updateStatus(notification.id, NotificationStatus.SENT);

        } catch (error: any) {
            console.error('Failed to send notification:', error);
            await NotificationRepository.updateStatus(notification.id, NotificationStatus.FAILED, error.message);
        }

        return notification;
    }
}
