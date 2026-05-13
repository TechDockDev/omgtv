import { getPrisma } from "../lib/prisma";

interface JobLogger {
    info(obj: object | string, msg?: string): void;
    error(obj: object | string, msg?: string): void;
}

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setInterval> | null = null;
const prisma = getPrisma();

async function runSubscriptionExpiry(log: JobLogger) {
    try {
        const result = await prisma.userSubscription.updateMany({
            where: {
                status: { in: ['ACTIVE', 'TRIAL', 'CANCELED'] },
                endsAt: { lt: new Date() }
            },
            data: {
                status: 'EXPIRED',
                updatedAt: new Date()
            }
        });
        if (result.count > 0) {
            log.info({ count: result.count }, "expireSubscriptions job: expired stale subscriptions");
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
