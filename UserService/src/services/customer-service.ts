
import { PrismaClient, Prisma } from "@prisma/client";

export type CustomerDetailsFnResult = {
    name: string | null;
    email: string | null;
    phone: string | null;
    isProfileComplete: boolean;
};

import { loadConfig } from "../config";

// Singleton-ish client for Auth DB
export const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: loadConfig().AUTH_DATABASE_URL,
        },
    },
});

export class CustomerService {
    constructor(private readonly prisma: PrismaClient) { }

    private async getFirebaseUid(userId: string): Promise<string | null> {
        const query = Prisma.sql`
            SELECT 
                s.type,
                c."firebaseUid"
            FROM "AuthSubject" s
            LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
            WHERE s.id = ${userId}
        `;
        try {
            const result = await authPrisma.$queryRaw<any[]>(query);
            if (result.length === 0) {
                console.warn(`[CustomerService] User not found in AuthDB: ${userId}`);
                return null;
            }
            if (result[0]?.type === 'GUEST') {
                console.warn(`[CustomerService] User ${userId} is a GUEST, cannot update customer details`);
                return null;
            }
            return result[0]?.firebaseUid || null;
        } catch (e) {
            console.error("[CustomerService] Failed to resolve firebaseUid - check AUTH_DATABASE_URL config:", e);
            return null;
        }
    }

    async getCustomerDetails(userId: string): Promise<CustomerDetailsFnResult | null> {
        const firebaseUid = await this.getFirebaseUid(userId);
        if (!firebaseUid) return null;

        const profile = await this.prisma.customerProfile.findUnique({
            where: { firebaseUid },
        });

        if (!profile) {
            // Profile might not exist yet if only in AuthDB
            return {
                name: null,
                email: null,
                phone: null,
                isProfileComplete: false,
            };
        }

        const { name, email, phoneNumber } = profile;
        const isProfileComplete = Boolean(name && email && phoneNumber);

        return {
            name: name ?? null,
            email: email ?? null,
            phone: phoneNumber ?? null,
            isProfileComplete,
        };
    }

    async updateCustomerDetails(userId: string, data: { name?: string; email?: string }): Promise<void> {
        const firebaseUid = await this.getFirebaseUid(userId);
        if (!firebaseUid) {
            throw new Error("User not found or not a customer");
        }

        await this.prisma.customerProfile.upsert({
            where: { firebaseUid },
            create: {
                firebaseUid,
                name: data.name,
                email: data.email,
                status: "active",
            },
            update: {
                name: data.name,
                email: data.email,
            },
        });
    }

    async getBatchProfiles(ids: string[]): Promise<Record<string, CustomerDetailsFnResult>> {
        const profiles = await this.prisma.customerProfile.findMany({
            where: { id: { in: ids } },
        });

        const results: Record<string, CustomerDetailsFnResult> = {};
        profiles.forEach(profile => {
            const { id, name, email, phoneNumber } = profile;
            results[id] = {
                name: name ?? null,
                email: email ?? null,
                phone: phoneNumber ?? null,
                isProfileComplete: Boolean(name && email && phoneNumber),
            };
        });

        return results;
    }

    /**
     * Batch lookup by AuthSubject IDs (= x-user-id values from JWT sub).
     * Resolves AuthSubject.id → firebaseUid → CustomerProfile in one round trip each.
     * Returns a map keyed by the original authId.
     */
    async getBatchProfilesByAuthIds(authIds: string[]): Promise<Record<string, CustomerDetailsFnResult & { phoneNumber: string | null }>> {
        if (authIds.length === 0) return {};

        // 1. AuthSubject.id → CustomerIdentity.customerId (= CustomerProfile.id in UserService)
        const rows = await authPrisma.$queryRaw<{ auth_id: string; customerId: string | null }[]>(
            Prisma.sql`
                SELECT s.id AS auth_id, c."customerId"
                FROM "AuthSubject" s
                LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
                WHERE s.id IN (${Prisma.join(authIds)})
                  AND s.type != 'GUEST'
            `
        );

        const authToCustomer = new Map<string, string>();
        for (const row of rows) {
            if (row.customerId) authToCustomer.set(row.auth_id, row.customerId);
        }

        const customerIds = [...authToCustomer.values()];
        if (customerIds.length === 0) return {};

        // 2. Batch fetch CustomerProfiles directly by id
        const profiles = await this.prisma.customerProfile.findMany({
            where: { id: { in: customerIds } },
        });

        const customerToProfile = new Map(profiles.map(p => [p.id, p]));

        // 3. Build result keyed by original authId
        const results: Record<string, CustomerDetailsFnResult & { phoneNumber: string | null }> = {};
        for (const authId of authIds) {
            const customerId = authToCustomer.get(authId);
            const profile = customerId ? customerToProfile.get(customerId) : null;
            if (profile) {
                results[authId] = {
                    name: profile.name ?? null,
                    email: profile.email ?? null,
                    phone: profile.phoneNumber ?? null,
                    phoneNumber: profile.phoneNumber ?? null,
                    isProfileComplete: Boolean(profile.name && profile.email && profile.phoneNumber),
                };
            }
        }

        return results;
    }

    /**
     * Batch fetch FCM tokens by AuthSubject IDs (= x-user-id values from JWT sub).
     */
    async getFcmTokensByAuthIds(authIds: string[]): Promise<{ userId: string, fcmToken: string, deviceId: string }[]> {
        if (authIds.length === 0) return [];

        const rows = await authPrisma.$queryRaw<{ auth_id: string; customerId: string | null; firebaseUid: string | null }[]>(
            Prisma.sql`
                SELECT s.id AS auth_id, c."customerId", c."firebaseUid"
                FROM "AuthSubject" s
                LEFT JOIN "CustomerIdentity" c ON s.id = c."subjectId"
                WHERE s.id IN (${Prisma.join(authIds)})
            `
        );

        const authToCustomer = new Map<string, string>();
        const firebaseUids: string[] = [];
        const authIdToFirebaseUid = new Map<string, string>();

        for (const row of rows) {
            if (row.customerId) {
                authToCustomer.set(row.auth_id, row.customerId);
            } else if (row.firebaseUid) {
                firebaseUids.push(row.firebaseUid);
                authIdToFirebaseUid.set(row.auth_id, row.firebaseUid);
            }
        }

        // If some customerIds are missing in AuthDB, resolve them via firebaseUid from UserDB
        if (firebaseUids.length > 0) {
            const profiles = await this.prisma.customerProfile.findMany({
                where: { firebaseUid: { in: firebaseUids } },
                select: { id: true, firebaseUid: true }
            });
            const fbToId = new Map(profiles.map(p => [p.firebaseUid, p.id]));
            
            for (const [authId, fbUid] of authIdToFirebaseUid.entries()) {
                const cid = fbToId.get(fbUid);
                if (cid) {
                    authToCustomer.set(authId, cid);
                }
            }
        }

        const customerIds = [...authToCustomer.values()];
        if (customerIds.length === 0) return [];

        const links = await this.prisma.customerDeviceLink.findMany({
            where: { customerId: { in: customerIds } },
            include: {
                device: {
                    select: {
                        deviceId: true,
                        fcmToken: true,
                    },
                },
            },
        });

        const customerToAuthId = new Map<string, string>();
        for (const [authId, custId] of authToCustomer.entries()) {
            customerToAuthId.set(custId, authId);
        }

        const tokens = links
            .filter(link => link.device.fcmToken)
            .map(link => ({
                userId: customerToAuthId.get(link.customerId)!,
                fcmToken: link.device.fcmToken!,
                deviceId: link.device.deviceId,
            }));

        return tokens;
    }
}
