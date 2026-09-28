import { loadConfig } from "../config";

export class OtpClientError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "OtpClientError";
    }
}

// OTP mechanics live in AuthService — same primitives used by UserService's
// parental-PIN feature (AuthService/src/routes/internal-otp.ts). Reused as-is
// here to gate admin subscription/trial pricing edits.
export class AuthClient {
    private readonly baseUrl: string;
    private readonly serviceToken: string | undefined;

    constructor() {
        const config = loadConfig();
        this.baseUrl = config.AUTH_SERVICE_URL;
        this.serviceToken = config.SERVICE_AUTH_TOKEN;
    }

    private get headers(): Record<string, string> {
        const h: Record<string, string> = { "content-type": "application/json" };
        if (this.serviceToken) {
            h["x-service-token"] = this.serviceToken;
        }
        return h;
    }

    async sendOtp(phone: string): Promise<{ expiresIn: number }> {
        const res = await fetch(`${this.baseUrl}/internal/otp/send`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({ phone }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new OtpClientError(json?.message ?? `AuthService returned ${res.status}`, json?.code);
        }
        return json;
    }

    async verifyOtp(phone: string, code: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/internal/otp/verify`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({ phone, code }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new OtpClientError(json?.message ?? `AuthService returned ${res.status}`, json?.code);
        }
    }
}
