import { getPrisma } from "../lib/prisma";
import { trackSubscriptionEvent } from "../lib/analytics";

interface JobLogger {
    info(obj: object | string, msg?: string): void;
    error(obj: object | string, msg?: string): void;
}

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setInterval> | null = null;
const prisma = getPrisma();

async function runSubscriptionExpiry(log: JobLogger) {
    try {
        const now = new Date();
        const expiring = await prisma.userSubscription.findMany({
            where: { status: { in: ['ACTIVE', 'TRIAL', 'CANCELED'] }, endsAt: { lt: now } },
            select: { id: true, userId: true, planId: true, provider: true, trialPlanId: true, status: true },
        });

        if (expiring.length === 0) return;

        await prisma.userSubscription.updateMany({
            where: {
                id: { in: expiring.map(s => s.id) },
                status: { in: ['ACTIVE', 'TRIAL', 'CANCELED'] }, // guard: skip any renewed between SELECT and UPDATE
                endsAt: { lt: now },
            },
            data: { status: 'EXPIRED', updatedAt: now },
        });

        log.info({ count: expiring.length }, "expireSubscriptions job: expired stale subscriptions");

        for (const sub of expiring) {
            const isTrial = !!sub.trialPlanId;
            void trackSubscriptionEvent(sub.userId, isTrial ? "trial_expired" : "subscription_expired", {
                provider: sub.provider,
                plan_id: sub.planId ?? "",
                prior_status: sub.status,
            });
        }
    } catch (err) {
        log.error({ err }, "expireSubscriptions job failed");
    }
}

export function startSubscriptionExpiryCron(log: JobLogger) {
    if (timer) return;
    void runSubscriptionExpiry(log);
    timer = setInterval(() => void runSubscriptionExpiry(log), INTERVAL_MS);
    log.info("expireSubscriptions cron started (1h interval)");
}

export function stopSubscriptionExpiryCron() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
