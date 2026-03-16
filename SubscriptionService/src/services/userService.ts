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
    const { loadConfig } = require("../config");
    const config = loadConfig();
    const metadata = new (require("@grpc/grpc-js").Metadata)();
    metadata.add("authorization", config.SERVICE_AUTH_TOKEN ? `Bearer ${config.SERVICE_AUTH_TOKEN}` : "");

    // 1. Fetch Auth Info (AuthService - still single calls for now as AuthService doesn't have batch)
    // We get role and active status here.
    const authInfos = await Promise.all(
        userIds.map(async (id) => {
            return new Promise<any>((resolve) => {
                authClient.GetUserById({ user_id: id }, metadata, (err: any, response: any) => {
                    if (err) {
                        console.warn(`Failed to fetch auth user ${id}:`, err.message);
                        resolve(null);
                    } else {
                        resolve(response);
                    }
                });
            });
        })
    );

    // 2. Fetch Profiles in Batch (UserService - new batch RPC)
    const profiles = await new Promise<Record<string, any>>((resolve) => {
        userClient.BatchGetCustomerProfile({ customer_ids: userIds }, metadata, (err: any, response: any) => {
            if (err) {
                console.warn("Failed to fetch user profiles in batch:", err.message);
                resolve({});
            } else {
                resolve(response.profiles || {});
            }
        });
    });

    // 3. Merge Data
    userIds.forEach((id, index) => {
        const authUser = authInfos[index];
        const profile = profiles[id];

        if (authUser || profile) {
            userMap.set(id, {
                id,
                name: profile?.name || "Unknown",
                email: profile?.email || authUser?.email || "",
                role: authUser?.role || "CUSTOMER",
                isActive: authUser?.active ?? (profile?.status === "active"),
                phoneNumber: profile?.phone_number || "",
                avatar: profile?.avatar_url || "",
            });
        }
    });

    return userMap;
}
