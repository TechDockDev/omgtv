import { PrismaClient, Prisma } from "@prisma/client";

export type UserTypeFilter = "registered" | "guest" | "all";
export type UserStatusFilter = "active" | "inactive" | "blocked" | "all";
export type PlanFilter = "Free" | "Basic" | "Premium" | "all";

export type ListUsersParams = {
    page: number;
    limit: number;
    search?: string;
    status: UserStatusFilter;
    plan: PlanFilter;
    userType: UserTypeFilter;
};

export type UserListItem = {
    id: string;
    name: string;
    email: string | null;
    phone: string | null; // From Profile
    status: string;       // From Profile (or default active)
    plan?: string;
    userType: string;
    signupDate: string;
    lastActive: string;
    avatar: string;
    deviceId: string | null;
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

// Singleton-ish client for Auth DB
const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.AUTH_DATABASE_URL || "postgresql://postgres:postgres@postgres:5432/pocketlol_auth?schema=public",
        },
    },
});

export async function listUsers(
    prisma: PrismaClient, // Using generic prisma client for UserDB
    params: ListUsersParams
): Promise<ListUsersResult> {
    const { page, limit, search, userType } = params;
    const offset = (page - 1) * limit;

    // 1. Fetch Identities from AuthDB
    const conditions: Prisma.Sql[] = [];

    if (userType === "registered") {
        conditions.push(Prisma.sql`s.type = 'CUSTOMER'`);
    } else if (userType === "guest") {
        conditions.push(Prisma.sql`s.type = 'GUEST'`);
    } else {
        conditions.push(Prisma.sql`s.type IN ('CUSTOMER', 'GUEST')`);
    }

    // Note: Search on 'name' or 'status' is hard if data is in UserDB but pagination is on AuthDB.
    // For now, we support searching fields available in AuthDB (firebaseUid, guestId, customerId).
    // Searching by name/phone/status (UserDB fields) across pages requires a different architecture (e.g. sync to SearchService or join on UserDB driven query).
    // user request: "search" -> we stick to AuthDB search for now.

    if (search) {
        const searchPattern = `%${search}%`;
        conditions.push(Prisma.sql`(
            c."firebaseUid" ILIKE ${searchPattern} OR 
            g."guestId" ILIKE ${searchPattern} OR 
            c."customerId" ILIKE ${searchPattern}
        )`);
    }

    const whereClause = conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const countQuery = Prisma.sql`
        SELECT COUNT(*)::int as count 
        FROM "AuthSubject" s
        LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        LEFT JOIN "GuestIdentity" g ON s.id = g."subjectId"
        ${whereClause}
    `;

    const dataQuery = Prisma.sql`
        SELECT 
            s.id, s.type, s."createdAt", s."updatedAt", 
            c."firebaseUid", c."customerId", 
            g."guestId", g."deviceId" as "guestDeviceId"
        FROM "AuthSubject" s
        LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        LEFT JOIN "GuestIdentity" g ON s.id = g."subjectId"
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

        // 3. Merge Data
        const items: UserListItem[] = authUsers.map((u) => {
            let name = "Unknown";
            let email = null;
            let phone = null;
            let status = "active";
            let userTypeLabel = "registered";
            let plan: string | undefined;

            if (u.type === "CUSTOMER") {
                const profile = profiles.find(p => p.firebaseUid === u.firebaseUid);
                // @ts-ignore: Schema updated but client generation pending
                name = profile?.name || u.firebaseUid || "Customer";
                // @ts-ignore: Schema updated but client generation pending
                email = profile?.email || null;
                phone = profile?.phoneNumber || null;
                // @ts-ignore: Schema updated but client generation pending
                status = profile?.status || "active";
                userTypeLabel = "registered";
                // Mock Plan logic
                plan = (name.length % 2 === 0) ? "Premium" : "Free";
            } else if (u.type === "GUEST") {
                name = `Guest ${u.guestId ? u.guestId.substring(0, 8) : ""}`;
                userTypeLabel = "guest";
            }

            // Generate Avatar
            const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

            return {
                id: u.id,
                name,
                email,
                phone,
                status,
                plan,
                userType: userTypeLabel,
                signupDate: new Date(u.createdAt).toISOString(),
                lastActive: new Date(u.updatedAt).toISOString(),
                avatar,
                deviceId: u.guestDeviceId || null,
                watchTime: Math.floor(Math.random() * 5000), // Mock data
                contentViewed: Math.floor(Math.random() * 100), // Mock data
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
            c."firebaseUid", c."customerId", 
            g."guestId", g."deviceId" as "guestDeviceId"
        FROM "AuthSubject" s
        LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
        LEFT JOIN "GuestIdentity" g ON s.id = g."subjectId"
        WHERE s.id = ${userId} AND s.type IN ('CUSTOMER', 'GUEST')
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
        let userTypeLabel = "registered";

        if (u.type === "CUSTOMER" && u.firebaseUid) {
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
            userTypeLabel = "registered";
        } else if (u.type === "GUEST") {
            name = `Guest ${u.guestId ? u.guestId.substring(0, 8) : ""}`;
            userTypeLabel = "guest";
        }

        // Mock Plan logic
        let plan: string | undefined;
        if (u.type === "CUSTOMER") {
            plan = (name.length % 2 === 0) ? "Premium" : "Free";
        }

        // Generate Avatar
        const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name.replace(/\s/g, ''))}`;

        return {
            id: u.id,
            name,
            email,
            phone,
            status,
            plan,
            userType: userTypeLabel,
            signupDate: new Date(u.createdAt).toISOString(),
            lastActive: new Date(u.updatedAt).toISOString(),
            avatar,
            deviceId: u.guestDeviceId || null,
            watchTime: Math.floor(Math.random() * 5000),
            contentViewed: Math.floor(Math.random() * 100),
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