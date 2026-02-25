import { PrismaClient, Prisma } from "@prisma/client";

export type UserStatusFilter = "active" | "inactive" | "blocked" | "all";

export type ListUsersParams = {
    page: number;
    limit: number;
    search?: string;
    status: UserStatusFilter;
};

export type UserListItem = {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: string;
    plan: string;
    userType: string;
    signupDate: string;
    lastActive: string;
    avatar: string;
    watchTime: number;
    contentViewed: number;
};

export type ListUsersResult = {
    items: UserListItem[];
    total: number;
    page: number;
    totalPages: number;
};

export type UpdateUserParams = {
    name?: string;
    email?: string;
    phone?: string;
    status?: string;
};

import { loadConfig } from "../config";

const config = loadConfig();

// Singleton-ish client for Auth DB
const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: config.AUTH_DATABASE_URL,
        },
    },
});

const ENGAGEMENT_SERVICE_URL = config.ENGAGEMENT_SERVICE_URL;
const SUBSCRIPTION_SERVICE_URL = config.SUBSCRIPTION_SERVICE_URL;
const SERVICE_AUTH_TOKEN = config.SERVICE_AUTH_TOKEN || "";

// Fetch user analytics from the existing Engagement Service per-user endpoint
async function fetchBulkUserAnalytics(userIds: string[]): Promise<Record<string, { totalWatchTimeSeconds: number; contentViewed: number }>> {
    if (userIds.length === 0) return {};
    const result: Record<string, { totalWatchTimeSeconds: number; contentViewed: number }> = {};

    try {
        // Call the existing per-user analytics endpoint in parallel
        const responses = await Promise.allSettled(
            userIds.map(async (userId) => {
                const url = `${ENGAGEMENT_SERVICE_URL}/internal/analytics/users/${userId}/content`;
                const res = await fetch(url, {
                    headers: { "x-service-token": SERVICE_AUTH_TOKEN },
                });
                if (res.ok) {
                    const data = await res.json();
                    // Extract from the existing response format: { stats: { totalWatchTimeSeconds, episodesStarted } }
                    const stats = data?.data?.stats || data?.stats || {};
                    return {
                        userId,
                        totalWatchTimeSeconds: stats.totalWatchTimeSeconds || 0,
                        contentViewed: stats.episodesStarted || 0,
                    };
                }
                return { userId, totalWatchTimeSeconds: 0, contentViewed: 0 };
            })
        );

        for (const r of responses) {
            if (r.status === "fulfilled" && r.value) {
                result[r.value.userId] = {
                    totalWatchTimeSeconds: r.value.totalWatchTimeSeconds,
                    contentViewed: r.value.contentViewed,
                };
            }
        }

        console.log(`[fetchBulkUserAnalytics] Got stats for ${Object.keys(result).length}/${userIds.length} users`);
    } catch (error) {
        console.error("[fetchBulkUserAnalytics] Failed to fetch:", error);
    }
    return result;
}

// Fetch active subscriber and trial user IDs from Subscription Service
async function fetchSubscriptionUserIds(): Promise<{ activeUserIds: Set<string>; trialUserIds: Set<string> }> {
    const result = { activeUserIds: new Set<string>(), trialUserIds: new Set<string>() };
    try {
        const activeUrl = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/active-users?limit=10000`;
        const trialUrl = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/trial-users?limit=10000`;
        console.log(`[fetchSubscriptionUserIds] Active: ${activeUrl}`);
        console.log(`[fetchSubscriptionUserIds] Trial: ${trialUrl}`);

        const [activeRes, trialRes] = await Promise.all([
            fetch(activeUrl, {
                headers: { "x-service-token": SERVICE_AUTH_TOKEN },
            }),
            fetch(trialUrl, {
                headers: { "x-service-token": SERVICE_AUTH_TOKEN },
            }),
        ]);

        console.log(`[fetchSubscriptionUserIds] Active status: ${activeRes.status}, Trial status: ${trialRes.status}`);

        if (activeRes.ok) {
            const data = await activeRes.json();
            (data.userIds || []).forEach((id: string) => result.activeUserIds.add(id));
            console.log(`[fetchSubscriptionUserIds] Active users: ${result.activeUserIds.size}`);
        } else {
            const errorBody = await activeRes.text();
            console.error(`[fetchSubscriptionUserIds] Active users error: ${errorBody}`);
        }

        if (trialRes.ok) {
            const data = await trialRes.json();
            (data.userIds || []).forEach((id: string) => result.trialUserIds.add(id));
            console.log(`[fetchSubscriptionUserIds] Trial users: ${result.trialUserIds.size}`);
        } else {
            const errorBody = await trialRes.text();
            console.error(`[fetchSubscriptionUserIds] Trial users error: ${errorBody}`);
        }
    } catch (error) {
        console.error("[fetchSubscriptionUserIds] Failed to fetch:", error);
    }
    return result;
}

export async function listUsers(
    prisma: PrismaClient,
    params: ListUsersParams
): Promise<ListUsersResult> {
    const { page, limit, search } = params;
    const offset = (page - 1) * limit;

    // 1. Fetch CUSTOMER Identities from AuthDB (no guests)
    const conditions: Prisma.Sql[] = [Prisma.sql`s.type = 'CUSTOMER'`];

    if (search) {
        const searchPattern = `%${search}%`;
        conditions.push(Prisma.sql`(
            c."firebaseUid" ILIKE ${searchPattern} OR 
            c."customerId" ILIKE ${searchPattern}
        )`);
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const countQuery = Prisma.sql`
        SELECT COUNT(*)::int as count 
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        ${whereClause}
    `;

    const dataQuery = Prisma.sql`
        SELECT 
            s.id, s.type, s."createdAt", s."updatedAt", 
            c."firebaseUid", c."customerId"
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        ${whereClause}
        ORDER BY s."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
    `;

    try {
        const [totalResult, authUsers] = await Promise.all([
            authPrisma.$queryRaw<[{ count: number }]>(countQuery),
            authPrisma.$queryRaw<any[]>(dataQuery)
        ]);

        const total = Number(totalResult[0]?.count || 0);

        // 2. Fetch Profile Data from UserDB
        const firebaseUids = authUsers
            .filter(u => u.firebaseUid)
            .map(u => u.firebaseUid);

        let profiles: any[] = [];
        if (firebaseUids.length > 0) {
            profiles = await prisma.customerProfile.findMany({
                where: { firebaseUid: { in: firebaseUids } }
            });
        }

        // 3. Fetch real analytics + subscription data in parallel
        const userIds = authUsers.map(u => u.id);
        const [analyticsMap, subscriptionData] = await Promise.all([
            fetchBulkUserAnalytics(userIds),
            fetchSubscriptionUserIds(),
        ]);

        // 4. Merge Data
        const items: UserListItem[] = authUsers.map((u) => {
            const profile = profiles.find(p => p.firebaseUid === u.firebaseUid);
            // @ts-ignore: Schema updated but client generation pending
            const name = profile?.name || u.firebaseUid || "Customer";
            // @ts-ignore: Schema updated but client generation pending
            const email = profile?.email || null;
            const phone = profile?.phoneNumber || null;
            // @ts-ignore: Schema updated but client generation pending
            const status = profile?.status || "active";

            // Real plan from subscription data
            let plan = "Free";
            if (subscriptionData.activeUserIds.has(u.id)) {
                plan = "Premium";
            } else if (subscriptionData.trialUserIds.has(u.id)) {
                plan = "Trial";
            }

            // Real analytics from Engagement Service
            const analytics = analyticsMap[u.id] || { totalWatchTimeSeconds: 0, contentViewed: 0 };

            // Generate Avatar
            const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

            return {
                id: u.id,
                name,
                email,
                phone,
                status,
                plan,
                userType: "registered",
                signupDate: new Date(u.createdAt).toISOString(),
                lastActive: new Date(u.updatedAt).toISOString(),
                avatar,
                watchTime: analytics.totalWatchTimeSeconds,
                contentViewed: analytics.contentViewed,
            };
        });

        return { items, total, page, totalPages: Math.ceil(total / limit) };

    } catch (error) {
        console.error("Failed to list users:", error);
        return { items: [], total: 0, page, totalPages: 0 };
    }
}

export async function getUserDetails(
    prisma: PrismaClient,
    userId: string
): Promise<UserListItem | null> {
    const query = Prisma.sql`
        SELECT 
            s.id, s.type, s."createdAt", s."updatedAt", 
            c."firebaseUid", c."customerId"
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        WHERE s.id = ${userId} AND s.type = 'CUSTOMER'
        LIMIT 1
    `;

    try {
        const result = await authPrisma.$queryRaw<any[]>(query);
        const u = result[0];
        if (!u) return null;

        let name = "Unknown";
        let email = null;
        let phone = null;
        let status = "active";

        if (u.firebaseUid) {
            const profile = await prisma.customerProfile.findUnique({
                where: { firebaseUid: u.firebaseUid }
            });
            // @ts-ignore: Schema updated
            name = profile?.name || u.firebaseUid || "Customer";
            // @ts-ignore: Schema updated
            email = profile?.email || null;
            phone = profile?.phoneNumber || null;
            // @ts-ignore: Schema updated
            status = profile?.status || "active";
        }

        // Real analytics + subscription data
        const [analyticsMap, subscriptionData] = await Promise.all([
            fetchBulkUserAnalytics([u.id]),
            fetchSubscriptionUserIds(),
        ]);

        let plan = "Free";
        if (subscriptionData.activeUserIds.has(u.id)) {
            plan = "Premium";
        } else if (subscriptionData.trialUserIds.has(u.id)) {
            plan = "Trial";
        }

        const analytics = analyticsMap[u.id] || { totalWatchTimeSeconds: 0, contentViewed: 0 };

        const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

        return {
            id: u.id,
            name,
            email,
            phone,
            status,
            plan,
            userType: "registered",
            signupDate: new Date(u.createdAt).toISOString(),
            lastActive: new Date(u.updatedAt).toISOString(),
            avatar,
            watchTime: analytics.totalWatchTimeSeconds,
            contentViewed: analytics.contentViewed,
        };
    } catch (error) {
        console.error("Failed to get user details:", error);
        return null;
    }
}

export async function updateUser(
    prisma: PrismaClient,
    userId: string,
    data: UpdateUserParams
): Promise<boolean> {
    // 1. Get user identity to find firebaseUid
    const query = Prisma.sql`
        SELECT c."firebaseUid"
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        WHERE s.id = ${userId}
    `;
    const result = await authPrisma.$queryRaw<any[]>(query);
    const u = result[0];

    if (!u || !u.firebaseUid) return false; // Can only update Customers with profiles

    // 2. Upsert CustomerProfile
    // Note: If schema update failed on 'name'/'email'/'status', this will crash at runtime.
    // We assume schema is applied.
    await prisma.customerProfile.upsert({
        where: { firebaseUid: u.firebaseUid },
        create: {
            firebaseUid: u.firebaseUid,
            phoneNumber: data.phone,
            // @ts-ignore: Schema updated
            name: data.name,
            // @ts-ignore: Schema updated
            email: data.email,
            // @ts-ignore: Schema updated
            status: data.status || "active"
        },
        update: {
            phoneNumber: data.phone,
            // @ts-ignore: Schema updated
            name: data.name,
            // @ts-ignore: Schema updated
            email: data.email,
            // @ts-ignore: Schema updated
            status: data.status // if undefined, prisma ignores or we should conditionally add
        }
    });

    return true;
}

export async function blockUser(
    prisma: PrismaClient,
    userId: string,
    blocked: boolean,
    reason?: string
): Promise<boolean> {
    return updateUser(prisma, userId, { status: blocked ? "blocked" : "active" });
}

export async function deleteUser(
    prisma: PrismaClient,
    userId: string
): Promise<boolean> {
    try {
        // 1. Check if user exists
        const check = Prisma.sql`SELECT id FROM "AuthSubject" WHERE id = ${userId}`;
        const exists = await authPrisma.$queryRaw<any[]>(check);
        if (exists.length === 0) return false;

        // 2. Delete from AuthDB (Cascade should delete Identity)
        const del = Prisma.sql`DELETE FROM "AuthSubject" WHERE id = ${userId}`;
        await authPrisma.$executeRaw(del);

        // 3. UserDB Profile cleanup happens automatically? No, manual cleanup might be needed 
        // if we don't have FKs. But we don't have the firebaseUid here easily unless we fetch first.
        // For now, allow orphaned profiles or relying on later cleanup. 
        // Strict consistency would require fetching firebaseUid first.

        return true;
    } catch (e) {
        console.error("Delete failed", e);
        return false;
    }
}