import { NotificationType } from '@prisma/client';

export interface EmailPayload {
    to: string;
    subject: string;
    html: string;
    text?: string;
    from?: string;
}

export interface PushPayload {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    imageUrl?: string;
}

export interface NotificationProvider {
    type: NotificationType;
    send(payload: unknown): Promise<unknown>;
}

export interface EmailProvider extends NotificationProvider {
    type: 'EMAIL';
    send(payload: EmailPayload): Promise<{ messageId: string }>;
}

export interface PushProvider extends NotificationProvider {
    type: 'PUSH';
    send(payload: PushPayload): Promise<{ messageId: string }>;
}
