import { getAuthClient, getUserClient } from "../lib/grpc";
import { promisify } from "util";

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
 * Fetches user details for a list of user IDs.
 * Uses AuthService to get customerId, then UserService to get profile.
 */
export async function fetchUserDetails(userIds: string[]): Promise<Map<string, User>> {
    const userMap = new Map<string, User>();
    const authClient = getAuthClient();
    const userClient = getUserClient();

    // Create a promise-based wrapper for GetUserById
    const getUserById = (id: string): Promise<any> => {
        return new Promise((resolve) => {
            authClient.GetUserById({ user_id: id }, (err: any, response: any) => {
                if (err) {
                    console.warn(`Failed to fetch auth user ${id}:`, err.message);
                    resolve(null);
                } else {
                    resolve(response);
                }
            });
        });
    };

    // Create a promise-based wrapper for GetCustomerProfile
    const getCustomerProfile = (customerId: string): Promise<any> => {
        return new Promise((resolve) => {
            userClient.GetCustomerProfile({ customer_id: customerId }, (err: any, response: any) => {
                if (err) {
                    // It's okay if profile fetch fails, we fall back to auth info
                    console.warn(`Failed to fetch customer profile ${customerId}:`, err.message);
                    resolve(null);
                } else {
                    resolve(response);
                }
            });
        });
    };

    await Promise.all(
        userIds.map(async (id) => {
            try {
                const authUser = await getUserById(id);
                if (authUser) {
                    let name = "Unknown";
                    let phoneNumber = "";
                    let email = authUser.email;

                    // If we have a customer_id, try to fetch rich profile from UserService
                    if (authUser.customer_id) {
                        const profile = await getCustomerProfile(authUser.customer_id);
                        if (profile) {
                            name = profile.name || name;
                            phoneNumber = profile.phone_number || phoneNumber;
                            email = profile.email || email; // Profile email might be more up to date? Or use auth email.
                        }
                    }

                    userMap.set(id, {
                        id,
                        name,
                        email,
                        role: authUser.role,
                        isActive: authUser.active,
                        phoneNumber,
                    });
                }
            } catch (e) {
                console.error(`Error fetching details for user ${id}`, e);
            }
        })
    );

    return userMap;
}
