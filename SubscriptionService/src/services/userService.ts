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

    const customerIds = authInfos.map((info) => info?.customer_id).filter((id) => !!id);

    // 2. Fetch Profiles in Batch (UserService)
    const batchProfiles = await new Promise<Record<string, any>>((resolve) => {
        if (customerIds.length === 0) {
            resolve({});
            return;
        }
        userClient.BatchGetCustomerProfile({ customer_ids: customerIds }, metadata, (err: any, response: any) => {
            if (err) {
                console.warn("BatchGetCustomerProfile failed:", err.message);
                resolve({});
            } else {
                resolve(response.profiles || {});
            }
        });
    });

    // Fall back to individual GetCustomerProfile for any IDs missing from the batch result
    const missingCustomerIds = customerIds.filter((id) => !batchProfiles[id]);
    const individualProfiles: Record<string, any> = {};
    if (missingCustomerIds.length > 0) {
        await Promise.all(
            missingCustomerIds.map((id) =>
                new Promise<void>((resolve) => {
                    userClient.GetCustomerProfile({ customer_id: id }, metadata, (err: any, response: any) => {
                        if (!err && response) {
                            individualProfiles[id] = response;
                        }
                        resolve();
                    });
                })
            )
        );
    }

    const profiles: Record<string, any> = { ...batchProfiles, ...individualProfiles };

    // 3. Merge Data
    userIds.forEach((id, index) => {
        const authUser = authInfos[index];
        const customerId = authUser?.customer_id;
        const profile = customerId ? profiles[customerId] : null;

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
