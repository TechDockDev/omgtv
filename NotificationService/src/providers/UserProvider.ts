
export interface UserSearchFilters {
    platform?: 'ios' | 'android' | 'web';
    createdAtStart?: string;
    createdAtEnd?: string;
}

export class UserProvider {
    private userServiceUrl: string;
    private subscriptionServiceUrl: string;

    constructor() {
        this.userServiceUrl = process.env.USER_SERVICE_URL || 'http://localhost:4500';
        this.subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL || 'http://localhost:4700';
    }

    /**
     * Fetch users matching specific criteria from UserService
     */
    async getUsersByCriteria(filters: UserSearchFilters, limit = 1000): Promise<string[]> {
        try {
            const response = await fetch(`${this.userServiceUrl}/internal/users/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters, limit })
            });

            if (!response.ok) {
                throw new Error(`UserService returned ${response.status}`);
            }

            const data = await response.json() as { userIds: string[] };
            return data.userIds;
        } catch (error) {
            console.error('Failed to fetch users by criteria:', error);
            return [];
        }
    }

    /**
     * Fetch all active subscribers from SubscriptionService
     */
    async getActiveSubscribers(limit = 1000): Promise<string[]> {
        try {
            // TODO: Handle pagination properly for production (loop until done)
            // For MVP, just fetching top N
            const response = await fetch(`${this.subscriptionServiceUrl}/internal/subscriptions/active-users?limit=${limit}`);

            if (!response.ok) {
                throw new Error(`SubscriptionService returned ${response.status}`);
            }

            const data = await response.json() as { userIds: string[] };
            return data.userIds;
        } catch (error) {
            console.error('Failed to fetch active subscribers:', error);
            return [];
        }
    }
}

export const userProvider = new UserProvider();
