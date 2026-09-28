import { loadConfig } from "../config";

export class AdminProfileClient {
    private readonly baseUrl: string;
    private readonly serviceToken: string | undefined;

    constructor() {
        const config = loadConfig();
        this.baseUrl = config.USER_SERVICE_URL;
        this.serviceToken = config.SERVICE_AUTH_TOKEN;
    }

    async getPhoneNumber(adminId: string): Promise<string | null> {
        const res = await fetch(`${this.baseUrl}/internal/admin-profile/${adminId}`, {
            headers: this.serviceToken ? { "x-service-token": this.serviceToken } : {},
        });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`UserService returned ${res.status} resolving admin profile`);
        }
        const json = await res.json();
        return json.phoneNumber ?? null;
    }
}
