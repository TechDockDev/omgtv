import { EmailPayload, EmailProvider } from './interfaces';

export class SmtpEmailProvider implements EmailProvider {
    type: 'EMAIL' = 'EMAIL';

    constructor() {
        console.log(`SMTP Provider disabled (email not needed)`);
    }

    async send(payload: EmailPayload): Promise<{ messageId: string }> {
        // Mock fallback
        console.log('--- EMAIL SENT (MOCK - FALLBACK) ---');
        console.log(`To: ${payload.to}`);
        console.log(`Subject: ${payload.subject}`);
        console.log(`Body: ${payload.text || payload.html.substring(0, 50)}...`);
        console.log('-------------------------');

        return { messageId: `mock-email-${Date.now()}` };
    }
}
