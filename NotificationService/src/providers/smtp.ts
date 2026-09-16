import nodemailer, { Transporter } from 'nodemailer';
import { EmailPayload, EmailProvider } from './interfaces';
import { loadConfig } from '../config';

export class SmtpEmailProvider implements EmailProvider {
    type: 'EMAIL' = 'EMAIL';
    private transporter: Transporter;
    private fromAddress: string;

    constructor() {
        const config = loadConfig();
        this.fromAddress = config.SMTP_FROM ?? config.SMTP_USER;
        this.transporter = nodemailer.createTransport({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_PORT === 465,
            auth: {
                user: config.SMTP_USER,
                pass: config.SMTP_PASS,
            },
        });
    }

    async send(payload: EmailPayload): Promise<{ messageId: string }> {
        const info = await this.transporter.sendMail({
            from: payload.from ?? this.fromAddress,
            to: payload.to,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
        });
        return { messageId: info.messageId };
    }
}
