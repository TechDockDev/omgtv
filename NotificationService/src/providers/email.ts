import { EmailPayload, EmailProvider } from './interfaces';
import { NotificationType } from '@prisma/client';

export class ConsoleEmailProvider implements EmailProvider {
    type: 'EMAIL' = 'EMAIL';

    async send(payload: EmailPayload): Promise<{ messageId: string }> {
        console.log('--- EMAIL SENT (MOCK) ---');
        console.log(`To: ${payload.to}`);
        console.log(`Subject: ${payload.subject}`);
        console.log(`Body: ${payload.text || payload.html.substring(0, 50)}...`);
        console.log('-------------------------');

        return { messageId: `mock-email-${Date.now()}` };
    }
}
