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

    async sendPush(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
        try {
            const res = await fetch(`${this.baseUrl}/internal/push/send`, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ userId, title, body, ...(data && { data }) }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`NotificationService returned ${res.status}: ${text}`);
            }
        } catch (err) {
            // Non-fatal: log but don't break the payment flow
            console.warn("[NotificationClient] Push failed (non-fatal):", err);
        }
    }

    async sendPushStrict(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
        const res = await fetch(`${this.baseUrl}/internal/push/send`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({ userId, title, body, ...(data && { data }) }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`NotificationService returned ${res.status}: ${text}`);
        }
    }

    async hasSentRecently(userId: string, type: string, withinMinutes: number = 120): Promise<boolean> {
        const history = await this.getBulkHistory([userId], type);
        const lastSentAt = history[userId]?.lastSentAt;
        if (!lastSentAt) return false;
        return (Date.now() - new Date(lastSentAt).getTime()) < withinMinutes * 60_000;
    }

    async getBulkHistory(userIds: string[], type?: string): Promise<Record<string, { lastSentAt: string | null; count: number }>> {
        if (userIds.length === 0) return {};

        const CHUNK_SIZE = 500;
        const merged: Record<string, { lastSentAt: string | null; count: number }> = {};

        for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
            const chunk = userIds.slice(i, i + CHUNK_SIZE);
            try {
                const res = await fetch(`${this.baseUrl}/internal/notifications/bulk-history`, {
                    method: "POST",
                    headers: this.headers,
                    body: JSON.stringify({ userIds: chunk, ...(type && { type }) }),
                });
                if (!res.ok) continue;
                const json = await res.json() as { history: Record<string, { lastSentAt: string | null; count: number }> };
                Object.assign(merged, json.history ?? {});
            } catch {
                // non-fatal: missing history means we may over-send, but won't crash
            }
        }

        return merged;
    }
}
