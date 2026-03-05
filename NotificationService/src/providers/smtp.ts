import nodemailer from 'nodemailer';
import { EmailPayload, EmailProvider } from './interfaces';

export class SmtpEmailProvider implements EmailProvider {
    type: 'EMAIL' = 'EMAIL';
    private transporter: nodemailer.Transporter | null = null;

    constructor() {
        const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

        if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
            this.transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: parseInt(SMTP_PORT),
                secure: parseInt(SMTP_PORT) === 465,
                auth: {
                    user: SMTP_USER,
                    pass: SMTP_PASS,
                },
            });
            console.log(`SMTP Provider initialized: ${SMTP_HOST}:${SMTP_PORT}`);
        } else {
            const missing = [];
            if (!SMTP_HOST) missing.push("SMTP_HOST");
            if (!SMTP_PORT) missing.push("SMTP_PORT");
            if (!SMTP_USER) missing.push("SMTP_USER");
            if (!SMTP_PASS) missing.push("SMTP_PASS");
            throw new Error(`SMTP credentials missing: ${missing.join(", ")}`);
        }
    }

    async send(payload: EmailPayload): Promise<{ messageId: string }> {
        if (this.transporter) {
            try {
                const info = await this.transporter.sendMail({
                    from: payload.from || process.env.SMTP_FROM || 'no-reply@omgtv.in',
                    to: payload.to,
                    subject: payload.subject,
                    text: payload.text,
                    html: payload.html,
                });
                console.log(`Email sent successfully: ${info.messageId} to ${payload.to} (Subject: ${payload.subject})`);
                return { messageId: info.messageId };
            } catch (error) {
                console.error('Failed to send real email via SMTP:', error);
                throw error;
            }
        }

        // Mock fallback
        console.log('--- EMAIL SENT (MOCK - FALLBACK) ---');
        console.log(`To: ${payload.to}`);
        console.log(`Subject: ${payload.subject}`);
        console.log(`Body: ${payload.text || payload.html.substring(0, 50)}...`);
        console.log('-------------------------');

        return { messageId: `mock-email-${Date.now()}` };
    }
}
