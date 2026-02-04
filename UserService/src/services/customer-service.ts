
import { PrismaClient, Prisma } from "@prisma/client";

export type CustomerDetailsFnResult = {
    name: string | null;
    email: string | null;
    phone: string | null;
    isProfileComplete: boolean;
};

// Singleton-ish client for Auth DB (copied from user-management.ts pattern)
const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.AUTH_DATABASE_URL || "postgresql://postgres:postgres@postgres:5432/pocketlol_auth?schema=public",
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
}
