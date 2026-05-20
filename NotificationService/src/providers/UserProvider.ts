
export interface UserSearchFilters {
    platform?: 'ios' | 'android' | 'web';
    createdAtStart?: string;
    createdAtEnd?: string;
}

export class UserProvider {
    private userServiceUrl: string;
    private subscriptionServiceUrl: string;
    private serviceToken: string | undefined;

    constructor() {
        this.userServiceUrl = process.env.USER_SERVICE_URL || 'http://user-service:4500';
        this.subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL || 'http://subscription-service:5100';
        this.serviceToken = process.env.SERVICE_AUTH_TOKEN;
    }

    private get serviceHeaders(): Record<string, string> {
        const h: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.serviceToken) h['x-service-token'] = this.serviceToken;
        return h;
    }

    /**
     * Fetch users matching specific criteria from UserService
     */
    async getUsersByCriteria(filters: UserSearchFilters): Promise<string[]> {
        const allUserIds: string[] = [];
        const PAGE_SIZE = 5000;
        let offset = 0;

        try {
            while (true) {
                const response = await fetch(`${this.userServiceUrl}/internal/users/search`, {
                    method: 'POST',
                    headers: this.serviceHeaders,
                    body: JSON.stringify({ filters, limit: PAGE_SIZE, offset })
                });

                if (!response.ok) {
                    throw new Error(`UserService returned ${response.status}`);
                }

                const data = await response.json() as { userIds: string[] };
                const batch = data.userIds || [];
                allUserIds.push(...batch);

                // If we got fewer than PAGE_SIZE, we've reached the end
                if (batch.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }

            console.log(`[UserProvider] getUsersByCriteria: fetched ${allUserIds.length} total users`);
            return allUserIds;
        } catch (error) {
            console.error('Failed to fetch users by criteria:', error);
            return allUserIds; // Return whatever we collected so far
        }
    }

    /**
     * Fetch all active subscribers from SubscriptionService
     */
    async getActiveSubscribers(): Promise<string[]> {
        const allUserIds: string[] = [];
        const PAGE_SIZE = 5000;
        let offset = 0;

        try {
            while (true) {
                const response = await fetch(
                    `${this.subscriptionServiceUrl}/internal/subscriptions/active-users?limit=${PAGE_SIZE}&offset=${offset}`,
                    { headers: this.serviceHeaders }
                );

                if (!response.ok) {
                    throw new Error(`SubscriptionService returned ${response.status}`);
                }

                const data = await response.json() as { userIds: string[] };
                const batch = data.userIds || [];
                allUserIds.push(...batch);

                if (batch.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }

            console.log(`[UserProvider] getActiveSubscribers: fetched ${allUserIds.length} total users`);
            return allUserIds;
        } catch (error) {
            console.error('Failed to fetch active subscribers:', error);
            return allUserIds;
        }
    }

    /**
     * Fetch FCM tokens for a list of user IDs from UserService.
     * UserService stores FCM tokens on DeviceIdentity (populated during login).
     */
    async getFcmTokensForUsers(userIds: string[]): Promise<{ userId: string; fcmToken: string; deviceId: string }[]> {
        if (userIds.length === 0) return [];

        try {
            const response = await fetch(`${this.userServiceUrl}/internal/users/fcm-tokens`, {
                method: 'POST',
                headers: this.serviceHeaders,
                body: JSON.stringify({ userIds })
            });

            if (!response.ok) {
                throw new Error(`UserService returned ${response.status}`);
            }

            const data = await response.json() as { tokens: { userId: string; fcmToken: string; deviceId: string }[] };
            return data.tokens;
        } catch (error) {
            console.error('Failed to fetch FCM tokens from UserService:', error);
            return [];
        }
    }

    /**
     * Fetch user profiles for a list of user IDs from UserService.
     */
    async getUserProfiles(userIds: string[]): Promise<Record<string, { name: string | null; email: string | null; phone: string | null }>> {
        if (userIds.length === 0) return {};

        const serviceToken = process.env.SERVICE_AUTH_TOKEN;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (serviceToken) headers['x-service-token'] = serviceToken;

        try {
            const response = await fetch(`${this.userServiceUrl}/internal/users/profiles-by-auth-id`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ authIds: userIds })
            });

            if (!response.ok) {
                throw new Error(`UserService returned ${response.status}`);
            }

            const data = await response.json() as { profiles: Record<string, { name: string | null; email: string | null; phone: string | null }> };
            return data.profiles;
        } catch (error) {
            console.error('Failed to fetch user profiles from UserService:', error);
            return {};
        }
    }
}

export const userProvider = new UserProvider();
