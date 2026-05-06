export interface User {
    id: string;
    name: string;
    email: string;
    phoneNumber?: string;
    avatar?: string;
    role?: string;
    isActive?: boolean;
}

/**
 * Fetches user details for a list of auth user IDs (= x-user-id / JWT sub = AuthSubject.id).
 * Calls UserService's internal /profiles-by-auth-id endpoint which resolves
 * AuthSubject.id → firebaseUid → CustomerProfile in a single batch.
 */
export async function fetchUserDetails(userIds: string[]): Promise<Map<string, User>> {
    const userMap = new Map<string, User>();
    if (userIds.length === 0) return userMap;

    const userServiceUrl = process.env.USER_SERVICE_URL || 'http://user-service:4500';

    try {
        const response = await fetch(`${userServiceUrl}/internal/users/profiles-by-auth-id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authIds: userIds }),
        });

        if (!response.ok) {
            console.warn(`fetchUserDetails: UserService returned ${response.status}`);
            return userMap;
        }

        const data = await response.json() as { profiles: Record<string, any> };

        for (const [authId, profile] of Object.entries(data.profiles || {})) {
            userMap.set(authId, {
                id: authId,
                name: profile.name || 'Unknown',
                email: profile.email || '',
                phoneNumber: profile.phoneNumber || profile.phone || '',
                role: 'CUSTOMER',
                isActive: true,
            });
        }
    } catch (err) {
        console.error('fetchUserDetails: failed to fetch from UserService:', err);
    }

    return userMap;
}
