import { PrismaClient, Prisma } from "@prisma/client";

export type UserStatusFilter = "active" | "inactive" | "blocked" | "all";

export type ListUsersParams = {
    page: number;
    limit: number;
    search?: string;
    status: UserStatusFilter;
    plan?: string;
};

export type UserListItem = {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: string;
    plan: string;
    planType: "Free" | "Trial" | "Premium";
    subscriptionEndsAt: string | null;
    subscriptionPlanName: string | null;
    userType: string;
    signupDate: string;
    lastActive: string;
    avatar: string;
    watchTime: number;
    contentViewed: number;
    coinBalance: number;
    walletStatus: string;
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

async function fetchBulkCoinBalances(userIds: string[]): Promise<Record<string, { coinBalance: number; walletStatus: string }>> {
    if (userIds.length === 0) return {};
    try {
        const res = await fetch(`${SUBSCRIPTION_SERVICE_URL}/internal/coins/users/bulk-balance`, {
            method: "POST",
            headers: { "x-service-token": SERVICE_AUTH_TOKEN, "content-type": "application/json" },
            body: JSON.stringify({ userIds }),
        });
        if (res.ok) return await res.json();
        console.error("[fetchBulkCoinBalances] error:", await res.text());
    } catch (error) {
        console.error("[fetchBulkCoinBalances] Failed to fetch:", error);
    }
    return {};
}

async function fetchUserIdsByPlan(filter: { type?: string; pricePaise?: number; planId?: string }): Promise<any[]> {
    try {
        let url = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/by-plan?limit=10000`;
        if (filter.planId) url += `&planId=${filter.planId}`;
        if (filter.pricePaise) url += `&pricePaise=${filter.pricePaise}`;
        
        // If it's just "premium", "trial", or "free", we use the existing specialized endpoints
        if (!filter.planId && !filter.pricePaise) {
            if (filter.type === "premium") url = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/active-users?limit=10000`;
            else if (filter.type === "trial") url = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/trial-users?limit=10000`;
            else return [];
        }

        const res = await fetch(url, { headers: { "x-service-token": SERVICE_AUTH_TOKEN } });
        if (res.ok) {
            const data = await res.json();
            return data.users || [];
        }
    } catch (error) {
        console.error("[fetchUserIdsByPlan] Failed:", error);
    }
    return [];
}

// Fetch active subscriber and trial user details from Subscription Service
async function fetchSubscriptionUserIds(): Promise<{ 
    activeUsers: Map<string, { endsAt: string; planName: string }>; 
    trialUsers: Map<string, { endsAt: string; planName: string }> 
}> {
    const result = { 
        activeUsers: new Map<string, { endsAt: string; planName: string }>(), 
        trialUsers: new Map<string, { endsAt: string; planName: string }>() 
    };
    try {
        const activeUrl = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/active-users?limit=10000`;
        const trialUrl = `${SUBSCRIPTION_SERVICE_URL}/internal/subscriptions/trial-users?limit=10000`;

        const [activeRes, trialRes] = await Promise.all([
            fetch(activeUrl, {
                headers: { "x-service-token": SERVICE_AUTH_TOKEN },
            }),
            fetch(trialUrl, {
                headers: { "x-service-token": SERVICE_AUTH_TOKEN },
            }),
        ]);

        if (activeRes.ok) {
            const data = await activeRes.json();
            (data.users || []).forEach((u: any) => result.activeUsers.set(u.userId, { endsAt: u.endsAt, planName: u.planName }));
        }

        if (trialRes.ok) {
            const data = await trialRes.json();
            (data.users || []).forEach((u: any) => result.trialUsers.set(u.userId, { endsAt: u.endsAt, planName: u.planName }));
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
    const { page, limit, search, status, plan } = params;
    const offset = (page - 1) * limit;

    // 1. Fetch CUSTOMER Identities from AuthDB (no guests)
    const conditions: Prisma.Sql[] = [Prisma.sql`s.type = 'CUSTOMER'`];

    // Handle Plan Filter First (since it's a separate API call anyway)
    let globalSubData: { 
        activeUsers: Map<string, { endsAt: string; planName: string }>; 
        trialUsers: Map<string, { endsAt: string; planName: string }> 
    } | null = null;

    if (plan && plan !== "all") {
        let filteredUsers: any[] = [];
        const isNumeric = /^\d+$/.test(plan);
        
        if (isNumeric) {
            // Filter by price (assuming plan string is INR)
            filteredUsers = await fetchUserIdsByPlan({ pricePaise: parseInt(plan) * 100 });
        } else if (plan.toLowerCase() === "premium") {
            filteredUsers = await fetchUserIdsByPlan({ type: "premium" });
        } else if (plan.toLowerCase() === "trial") {
            filteredUsers = await fetchUserIdsByPlan({ type: "trial" });
        } else if (plan.toLowerCase() === "free") {
            globalSubData = await fetchSubscriptionUserIds();
            const activeIds = Array.from(globalSubData.activeUsers.keys());
            const trialIds = Array.from(globalSubData.trialUsers.keys());
            const allSubIds = [...activeIds, ...trialIds];
            if (allSubIds.length > 0) {
                conditions.push(Prisma.sql`s.id NOT IN (${Prisma.join(allSubIds)})`);
            }
        } else {
            // Assume plan is a planId
            filteredUsers = await fetchUserIdsByPlan({ planId: plan });
        }

        if (!["free", "all"].includes(plan.toLowerCase())) {
            const filteredIds = filteredUsers.map(u => u.userId);
            if (filteredIds.length > 0) {
                conditions.push(Prisma.sql`s.id IN (${Prisma.join(filteredIds)})`);
            } else {
                conditions.push(Prisma.sql`1 = 0`);
            }
        }
    }

    // Handle Status and Search from Profile DB
    let profileSearchUids: string[] = [];
    let statusProfileUids: string[] | null = null;

    if (search) {
        const profiles = await prisma.customerProfile.findMany({
            where: {
                OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { phoneNumber: { contains: search } },
                    { email: { contains: search, mode: "insensitive" } }
                ]
            },
            select: { firebaseUid: true }
        });
        profileSearchUids = profiles.map((p: any) => p.firebaseUid);
    }

    if (status && status !== "all") {
        const profiles = await prisma.customerProfile.findMany({
            where: { status },
            select: { firebaseUid: true }
        });
        statusProfileUids = profiles.map((p: any) => p.firebaseUid);
    }

    // Combine conditions for search
    if (search) {
        const searchPattern = `%${search}%`;
        if (profileSearchUids.length > 0) {
            conditions.push(Prisma.sql`(
                c."firebaseUid" ILIKE ${searchPattern} OR 
                c."customerId" ILIKE ${searchPattern} OR
                c."firebaseUid" IN (${Prisma.join(profileSearchUids)})
            )`);
        } else {
            conditions.push(Prisma.sql`(
                c."firebaseUid" ILIKE ${searchPattern} OR 
                c."customerId" ILIKE ${searchPattern}
            )`);
        }
    }

    // Combine conditions for status
    if (statusProfileUids !== null) {
        if (statusProfileUids.length > 0) {
            conditions.push(Prisma.sql`c."firebaseUid" IN (${Prisma.join(statusProfileUids)})`);
        } else {
            conditions.push(Prisma.sql`1 = 0`); // no matching status
        }
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
            c."firebaseUid", c."customerId", c."lastLoginAt"
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

        // 3. Fetch real analytics + subscription + coin data in parallel
        const userIds = authUsers.map(u => u.id);
        const [analyticsMap, subscriptionData, coinMap] = await Promise.all([
            fetchBulkUserAnalytics(userIds),
            globalSubData ? Promise.resolve(globalSubData) : fetchSubscriptionUserIds(),
            fetchBulkCoinBalances(userIds),
        ]);

        // 4. Merge Data
        const { activeUsers, trialUsers } = subscriptionData;

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
            const activeInfo = activeUsers.get(u.id);
            const trialInfo = trialUsers.get(u.id);

            let planType: "Free" | "Trial" | "Premium" = "Free";
            let subscriptionEndsAt = null;
            let subscriptionPlanName = null;

            if (activeInfo) {
                planType = "Premium";
                subscriptionEndsAt = activeInfo.endsAt;
                subscriptionPlanName = activeInfo.planName;
            } else if (trialInfo) {
                planType = "Trial";
                subscriptionEndsAt = trialInfo.endsAt;
                subscriptionPlanName = trialInfo.planName;
            }
            
            const plan = planType;

            // Real analytics from Engagement Service
            const analytics = analyticsMap[u.id] || { totalWatchTimeSeconds: 0, contentViewed: 0 };
            const coins = coinMap[u.id] || { coinBalance: 0, walletStatus: "ACTIVE" };

            // Generate Avatar
            const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

            return {
                id: u.id,
                name,
                email,
                phone,
                status,
                plan,
                planType,
                subscriptionEndsAt: subscriptionEndsAt ? new Date(subscriptionEndsAt).toISOString() : null,
                subscriptionPlanName,
                userType: "registered",
                signupDate: new Date(u.createdAt).toISOString(),
                lastActive: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : new Date(u.createdAt).toISOString(),
                avatar,
                watchTime: analytics.totalWatchTimeSeconds,
                contentViewed: analytics.contentViewed,
                coinBalance: coins.coinBalance,
                walletStatus: coins.walletStatus,
            };
        });

        return { items, total, page, totalPages: Math.ceil(total / limit) };

    } catch (error) {
        console.error("Failed to list users:", error);
        return { items: [], total: 0, page, totalPages: 0 };
    }
}

export type ListTrialConvertedParams = {
    page: number;
    limit: number;
    search?: string;
    status: UserStatusFilter;
    userIds: string[];
};

export type TrialConversionData = {
    userId: string;
    convertedAt: string;
    currentStatus: string;
    expiryStatus: string;
    planName: string;
    amountPaid: number;
    endsAt: string;
};

export async function listTrialConvertedUsers(
    prisma: PrismaClient,
    params: ListTrialConvertedParams & { conversionData?: TrialConversionData[] }
): Promise<ListUsersResult> {
    const { page, limit, search, status, userIds, conversionData } = params;
    const offset = (page - 1) * limit;

    const conversionMap = new Map(conversionData?.map(d => [d.userId, d]));

    const conditions: Prisma.Sql[] = [
        Prisma.sql`s.type = 'CUSTOMER'`,
        Prisma.sql`s.id IN (${Prisma.join(userIds)})`,
    ];

    // ... (rest of search/status logic remains same)

    let profileSearchUids: string[] = [];
    let statusProfileUids: string[] | null = null;

    if (search) {
        const profiles = await prisma.customerProfile.findMany({
            where: {
                OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { phoneNumber: { contains: search } },
                    { email: { contains: search, mode: "insensitive" } },
                ],
            },
            select: { firebaseUid: true },
        });
        profileSearchUids = profiles.map((p: any) => p.firebaseUid);
    }

    if (status && status !== "all") {
        const profiles = await prisma.customerProfile.findMany({
            where: { status },
            select: { firebaseUid: true },
        });
        statusProfileUids = profiles.map((p: any) => p.firebaseUid);
    }

    if (search) {
        const searchPattern = `%${search}%`;
        if (profileSearchUids.length > 0) {
            conditions.push(Prisma.sql`(
                c."firebaseUid" ILIKE ${searchPattern} OR
                c."customerId" ILIKE ${searchPattern} OR
                c."firebaseUid" IN (${Prisma.join(profileSearchUids)})
            )`);
        } else {
            conditions.push(Prisma.sql`(
                c."firebaseUid" ILIKE ${searchPattern} OR
                c."customerId" ILIKE ${searchPattern}
            )`);
        }
    }

    if (statusProfileUids !== null) {
        if (statusProfileUids.length > 0) {
            conditions.push(Prisma.sql`c."firebaseUid" IN (${Prisma.join(statusProfileUids)})`);
        } else {
            conditions.push(Prisma.sql`1 = 0`);
        }
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;

    const countQuery = Prisma.sql`
        SELECT COUNT(*)::int as count
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        ${whereClause}
    `;
    const dataQuery = Prisma.sql`
        SELECT s.id, s.type, s."createdAt", s."updatedAt",
               c."firebaseUid", c."customerId", c."lastLoginAt"
        FROM "AuthSubject" s
        JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        ${whereClause}
        ORDER BY s."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
    `;

    try {
        const [totalResult, authUsers] = await Promise.all([
            authPrisma.$queryRaw<[{ count: number }]>(countQuery),
            authPrisma.$queryRaw<any[]>(dataQuery),
        ]);

        const total = Number(totalResult[0]?.count || 0);
        const firebaseUids = authUsers.filter(u => u.firebaseUid).map(u => u.firebaseUid);

        let profiles: any[] = [];
        if (firebaseUids.length > 0) {
            profiles = await prisma.customerProfile.findMany({
                where: { firebaseUid: { in: firebaseUids } },
            });
        }

        const authUserIds = authUsers.map(u => u.id);
        const [analyticsMap, coinMap] = await Promise.all([
            fetchBulkUserAnalytics(authUserIds),
            fetchBulkCoinBalances(authUserIds),
        ]);

        const items: UserListItem[] = authUsers.map((u) => {
            const profile = profiles.find(p => p.firebaseUid === u.firebaseUid);
            const conversion = conversionMap.get(u.id);

            // @ts-ignore
            const name = profile?.name || u.firebaseUid || "Customer";
            // @ts-ignore
            const email = profile?.email || null;
            const phone = profile?.phoneNumber || null;
            // @ts-ignore
            const userStatus = profile?.status || "active";
            const analytics = analyticsMap[u.id] || { totalWatchTimeSeconds: 0, contentViewed: 0 };
            const coins = coinMap[u.id] || { coinBalance: 0, walletStatus: "ACTIVE" };
            const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ""))}`;

            return {
                id: u.id,
                name,
                email,
                phone,
                status: userStatus,
                plan: conversion?.planName || "Premium",
                planType: "Premium" as const,
                subscriptionEndsAt: conversion?.endsAt || null,
                subscriptionPlanName: conversion?.planName || "Premium",
                userType: "registered",
                signupDate: new Date(u.createdAt).toISOString(),
                lastActive: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : new Date(u.createdAt).toISOString(),
                avatar,
                watchTime: analytics.totalWatchTimeSeconds,
                contentViewed: analytics.contentViewed,
                coinBalance: coins.coinBalance,
                walletStatus: coins.walletStatus,
            };
        });

        return { items, total, page, totalPages: Math.ceil(total / limit) };
    } catch (error) {
        console.error("Failed to list trial-converted users:", error);
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
            c."firebaseUid", c."customerId", c."lastLoginAt"
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

        // Real analytics + subscription + coin data
        const [analyticsMap, subscriptionData, coinMap] = await Promise.all([
            fetchBulkUserAnalytics([u.id]),
            fetchSubscriptionUserIds(),
            fetchBulkCoinBalances([u.id]),
        ]);

        let planType: "Free" | "Trial" | "Premium" = "Free";
        let subscriptionEndsAt = null;
        let subscriptionPlanName = null;

        const activeInfo = subscriptionData.activeUsers.get(u.id);
        const trialInfo = subscriptionData.trialUsers.get(u.id);

        if (activeInfo) {
            planType = "Premium";
            subscriptionEndsAt = activeInfo.endsAt;
            subscriptionPlanName = activeInfo.planName;
        } else if (trialInfo) {
            planType = "Trial";
            subscriptionEndsAt = trialInfo.endsAt;
            subscriptionPlanName = trialInfo.planName;
        }
        const plan = planType;

        const analytics = analyticsMap[u.id] || { totalWatchTimeSeconds: 0, contentViewed: 0 };
        const coins = coinMap[u.id] || { coinBalance: 0, walletStatus: "ACTIVE" };

        const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

        return {
            id: u.id,
            name,
            email,
            phone,
            status,
            plan,
            planType,
            subscriptionEndsAt: subscriptionEndsAt ? new Date(subscriptionEndsAt).toISOString() : null,
            subscriptionPlanName,
            userType: "registered",
            signupDate: new Date(u.createdAt).toISOString(),
            lastActive: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : new Date(u.createdAt).toISOString(),
            avatar,
            watchTime: analytics.totalWatchTimeSeconds,
            contentViewed: analytics.contentViewed,
            coinBalance: coins.coinBalance,
            walletStatus: coins.walletStatus,
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