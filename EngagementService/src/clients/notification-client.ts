import { loadConfig } from "../config";

export class NotificationClient {
    private readonly baseUrl: string;
    private readonly serviceToken: string | undefined;

    constructor() {
        const config = loadConfig();
        this.baseUrl = config.NOTIFICATION_SERVICE_URL;
        this.serviceToken = config.SERVICE_AUTH_TOKEN;
    }

    private get headers(): Record<string, string> {
        const h: Record<string, string> = { "content-type": "application/json" };
        if (this.serviceToken) {
            h["x-service-token"] = this.serviceToken;
        }
        return h;
    }

    // Non-fatal by design: a report/ticket must still be created and returned
    // to the user even if the confirmation email fails to send.
    async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/internal/email/send`, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ to, subject, html }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`NotificationService returned ${res.status}: ${text}`);
            }
            return true;
        } catch (err) {
            console.warn("[NotificationClient] Email send failed (non-fatal):", err);
            return false;
        }
    }

    // Non-fatal by design: a complaint response must still save even if the
    // push notification fails (e.g. user has no registered device).
    async sendPush(userId: string, title: string, body: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/internal/push/send`, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ userId, title, body }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`NotificationService returned ${res.status}: ${text}`);
            }
            return true;
        } catch (err) {
            console.warn("[NotificationClient] Push send failed (non-fatal):", err);
            return false;
        }
    }
}
