import * as grpc from "@grpc/grpc-js";
import { getPrisma } from "../lib/prisma";

const prisma = getPrisma();

function normalizeActiveSubscription(subscription: {
    planId: string | null;
    trialPlanId: string | null;
    status: string;
    endsAt: Date;
} | null) {
    return {
        plan_id: subscription?.planId ?? subscription?.trialPlanId ?? "free",
        subscription_status: subscription?.status ?? "FREE",
        ends_at_unix_ms: subscription ? String(subscription.endsAt.getTime()) : "0",
    };
}

async function findActiveSubscription(userId: string) {
    return prisma.userSubscription.findFirst({
        where: {
            userId,
            status: { in: ["ACTIVE", "TRIAL", "CANCELED"] },
            endsAt: { gt: new Date() },
        },
        orderBy: { startsAt: "desc" },
    });
}

export const validateEpisodeAccess = async (
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
) => {
    const userId = call.request.user_id;
    const episodeId = call.request.content_id;

    try {
        const unlock = await prisma.userEpisodeUnlock.findUnique({
            where: { userId_episodeId: { userId, episodeId } }
        });

        const subscription = await findActiveSubscription(userId);

        const allowed = !!unlock || !!subscription;
        const normalized = normalizeActiveSubscription(subscription);

        callback(null, {
            allowed,
            reason: allowed ? "Access granted" : "Access denied. Episode not unlocked.",
            subscription_status: normalized.subscription_status,
            plan_id: normalized.plan_id,
        });
    } catch (error) {
        callback({
            code: grpc.status.INTERNAL,
            message: "Internal entitlement check failed"
        });
    }
};

export const validateReelAccess = async (
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
) => {
    const userId = call.request.user_id;

    try {
        const subscription = await findActiveSubscription(userId);
        const normalized = normalizeActiveSubscription(subscription);
        const allowed = Boolean(subscription);

        callback(null, {
            allowed,
            reason: allowed ? "Access granted" : "Access denied. Active subscription required.",
            subscription_status: normalized.subscription_status,
            plan_id: normalized.plan_id,
        });
    } catch (error) {
        callback({
            code: grpc.status.INTERNAL,
            message: "Internal entitlement check failed",
        });
    }
};

export const getUserSubscription = async (
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
) => {
    const userId = call.request.user_id;

    try {
        const subscription = await prisma.userSubscription.findFirst({
            where: { userId },
            orderBy: { startsAt: "desc" },
            include: { plan: true, trialPlan: true },
        });

        callback(null, {
            plan_id: subscription?.planId ?? subscription?.trialPlanId ?? "free",
            plan_name:
                subscription?.plan?.name ??
                (subscription?.trialPlan ? "Trial" : "Free"),
            status: subscription?.status ?? "FREE",
            ends_at_unix_ms: subscription ? String(subscription.endsAt.getTime()) : "0",
        });
    } catch (error) {
        callback({
            code: grpc.status.INTERNAL,
            message: "Failed to fetch user subscription",
        });
    }
};
