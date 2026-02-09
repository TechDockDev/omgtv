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
    const { loadConfig } = require("../config"); // Dynamic import or move to top if possible, verifying imports
    const config = loadConfig();
    const metadata = new (require("@grpc/grpc-js").Metadata)();
    metadata.add("authorization", config.SERVICE_AUTH_TOKEN ? `Bearer ${config.SERVICE_AUTH_TOKEN}` : "");


    // Create a promise-based wrapper for GetUserById
    const getUserById = (id: string): Promise<any> => {
        return new Promise((resolve) => {
            authClient.GetUserById({ user_id: id }, metadata, (err: any, response: any) => {
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
            userClient.GetCustomerProfile({ customer_id: customerId }, metadata, (err: any, response: any) => {
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
                console.log(`[DEBUG] GetUserById(${id}):`, JSON.stringify(authUser, null, 2));

                if (authUser) {
                    let name = "Unknown";
                    let phoneNumber = "";
                    let email = authUser.email;

                    // If we have a customer_id, try to fetch rich profile from UserService
                    if (authUser.customer_id) {
                        console.log(`[DEBUG] Fetching profile for customer_id: ${authUser.customer_id}`);
                        const profile = await getCustomerProfile(authUser.customer_id);
                        console.log(`[DEBUG] GetCustomerProfile(${authUser.customer_id}):`, JSON.stringify(profile, null, 2));

                        if (profile) {
                            name = profile.name || name;
                            phoneNumber = profile.phone_number || phoneNumber;
                            email = profile.email || email;
                        }
                    } else {
                        console.log(`[DEBUG] No customer_id found for user ${id}`);
                    }

                    userMap.set(id, {
                        id,
                        name,
                        email,
                        role: authUser.role,
                        isActive: authUser.active,
                        phoneNumber,
                    });
                } else {
                    console.log(`[DEBUG] Auth user not found for ${id}`);
                }
            } catch (e) {
                console.error(`Error fetching details for user ${id}`, e);
            }
        })
    );

    return userMap;
}
