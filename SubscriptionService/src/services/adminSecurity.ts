import type { PrismaClient } from "@prisma/client";
import { AuthClient, OtpClientError } from "../clients/auth-client";

export class AdminSecurityError extends Error {
    constructor(message: string, public readonly code: "NO_PHONE" | "OTP_FAILED" | "NOT_VERIFIED") {
        super(message);
        this.name = "AdminSecurityError";
    }
}

// How long a verified admin can edit plans/trial pricing before having to
// verify again. Deliberately short — this is a security gate, not a login.
const UNLOCK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Deliberately a single fixed number, not each admin's own profile phone —
// approval to change live pricing is gated behind one controlled phone,
// regardless of which admin account is making the request.
const SUBSCRIPTION_SECURITY_PHONE = "+917905339856";

export async function sendSubscriptionOtp(_adminId: string): Promise<{ expiresIn: number }> {
    const phone = SUBSCRIPTION_SECURITY_PHONE;
    try {
        return await new AuthClient().sendOtp(phone);
    } catch (err) {
        if (err instanceof OtpClientError) {
            throw new AdminSecurityError(err.message, "OTP_FAILED");
        }
        throw err;
    }
}

export async function verifySubscriptionOtp(params: {
    prisma: PrismaClient;
    adminId: string;
    otp: string;
}): Promise<{ verified: true; expiresAt: Date }> {
    const { prisma, adminId, otp } = params;
    const phone = SUBSCRIPTION_SECURITY_PHONE;

    try {
        await new AuthClient().verifyOtp(phone, otp);
    } catch (err) {
        if (err instanceof OtpClientError) {
            throw new AdminSecurityError(err.message, "OTP_FAILED");
        }
        throw err;
    }

    const verifiedAt = new Date();
    const expiresAt = new Date(verifiedAt.getTime() + UNLOCK_WINDOW_MS);

    await (prisma as any).adminSecurityVerification.upsert({
        where: { adminId },
        create: { adminId, verifiedAt, expiresAt },
        update: { verifiedAt, expiresAt },
    });

    return { verified: true, expiresAt };
}

export async function getSubscriptionUnlockStatus(params: {
    prisma: PrismaClient;
    adminId: string;
}): Promise<{ verified: boolean; expiresAt: Date | null }> {
    const { prisma, adminId } = params;
    const row = await (prisma as any).adminSecurityVerification.findUnique({ where: { adminId } });
    if (!row || row.expiresAt <= new Date()) {
        return { verified: false, expiresAt: null };
    }
    return { verified: true, expiresAt: row.expiresAt };
}

// preHandler for the plan/trial-plan write routes. Requires a recent OTP
// verification (see UNLOCK_WINDOW_MS) — a valid admin login alone is not enough.
export function requireSubscriptionUnlock(prisma: PrismaClient) {
    return async (request: any, reply: any) => {
        // See note in routes/admin/index.ts's OTP routes: APIGW's generic
        // wildcard proxy (used for all of SubscriptionService's /admin/* routes)
        // sets x-user-id, not x-admin-id.
        const adminId = request.headers["x-user-id"] as string | undefined;
        if (!adminId) {
            return reply.code(401).send({ message: "Missing admin identity" });
        }
        const status = await getSubscriptionUnlockStatus({ prisma, adminId });
        if (!status.verified) {
            return reply.code(403).send({
                code: "NOT_VERIFIED",
                message: "OTP verification required before editing subscription/trial pricing",
            });
        }
    };
}
