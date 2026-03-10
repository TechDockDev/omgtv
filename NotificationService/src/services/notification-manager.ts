import { NotificationType, NotificationStatus } from '@prisma/client';
import { NotificationRepository } from '../repositories/notification';
import { PreferenceRepository } from '../repositories/preference';
import { FcmProvider } from '../providers/fcm';
import { SmtpEmailProvider } from '../providers/smtp';
import { EmailPayload, PushPayload } from '../providers/interfaces';

export class NotificationManager {
    private emailProvider: SmtpEmailProvider;
    private pushProvider: FcmProvider;

    constructor() {
        this.emailProvider = new SmtpEmailProvider();
        this.pushProvider = new FcmProvider();
    }

    async sendDirectEmail(to: string, subject: string, body: string, isHtml: boolean = true) {
        const payload: EmailPayload = {
            to,
            subject,
            html: isHtml ? body : body.replace(/\n/g, '<br>'),
            text: isHtml ? undefined : body,
        };
        return await this.emailProvider.send(payload);
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
                let recipientEmail = payload?.email;

                if (!recipientEmail) {
                    try {
                        const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user-service:4500';
                        const response = await fetch(`${userServiceUrl}/internal/users/batch`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userIds: [userId] }),
                        });

                        if (response.ok) {
                            const data = await response.json() as any;
                            if (data.users && data.users[userId]) {
                                recipientEmail = data.users[userId].email;
                                console.log(`Resolved email for user ${userId} from UserService: ${recipientEmail}`);
                            }
                        }
                    } catch (err) {
                        console.error('Error fetching email from UserService:', err);
                    }
                }

                if (!recipientEmail) {
                    console.warn(`No email found for user ${userId} — skipping email notification`);
                    await NotificationRepository.updateStatus(notification.id, NotificationStatus.FAILED, 'No email address found');
                    return notification;
                }

                const emailPayload: EmailPayload = {
                    to: recipientEmail,
                    subject: title,
                    html: body,
                    text: body
                };

                await this.emailProvider.send(emailPayload);
            } else if (type === 'PUSH') {
                let tokens: string[] = [];
                if (payload?.token) tokens.push(payload.token);

                if (tokens.length === 0) {
                    try {
                        const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user-service:4500';
                        const response = await fetch(`${userServiceUrl}/internal/users/fcm-tokens`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userIds: [userId] }),
                        });

                        if (response.ok) {
                            const data = await response.json() as any;
                            if (data.tokens && data.tokens.length > 0) {
                                tokens = data.tokens.map((t: any) => t.fcmToken);
                                console.log(`Resolved ${tokens.length} FCM token(s) for user ${userId} from UserService`);
                            }
                        } else {
                            console.warn(`Failed to fetch FCM token from UserService: ${response.status}`);
                        }
                    } catch (err) {
                        console.error('Error fetching FCM token from UserService:', err);
                    }
                }

                if (tokens.length > 0) {
                    // De-duplicate tokens to ensure one push per unique token
                    const uniqueTokens = [...new Set(tokens)];

                    // Send to all registered tokens
                    await Promise.all(uniqueTokens.map(token =>
                        this.pushProvider.send({
                            token,
                            title,
                            body,
                            data: payload as any
                        })
                    ));
                } else {
                    console.warn(`No FCM token found for user ${userId} — skipping push notification`);
                    await NotificationRepository.updateStatus(notification.id, NotificationStatus.FAILED, 'No FCM token found');
                    return notification;
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
