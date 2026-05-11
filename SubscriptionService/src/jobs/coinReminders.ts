import { getPrisma } from "../lib/prisma";
import { CoinTransactionType, TransactionSource } from "@prisma/client";
import { NotificationClient } from "../clients/notification-client";

interface JobLogger {
    info(obj: object | string, msg?: string): void;
    error(obj: object | string, msg?: string): void;
}

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const COIN_REMINDER_HOURS = 6;       // remind when 6h left before coin expiry
const STREAK_BREAK_HOURS = 48;       // streak breaks after 48h
const STREAK_REMINDER_HOURS = 42;    // remind at 42h = 6h before break

let timer: ReturnType<typeof setInterval> | null = null;
const notificationClient = new NotificationClient();

// ── Notification 1: Expiring coins reminder ────────────────────────────────

async function runCoinExpiryReminders(log: JobLogger) {
    const prisma = getPrisma();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + COIN_REMINDER_HOURS * 60 * 60 * 1000);

    // Find all expirable coin credits expiring within 6h, not yet reminded
    const expiring = await prisma.coinTransaction.findMany({
        where: {
            type: CoinTransactionType.CREDIT,
            source: { in: [TransactionSource.AD, TransactionSource.STREAK, TransactionSource.STREAK_BONUS] },
            remainingAmount: { gt: 0 },
            expiryAt: { gte: now, lte: windowEnd },
            reminderSentAt: null,
        },
        select: { id: true, userId: true, remainingAmount: true, source: true },
        take: 1000,
    });

    if (expiring.length === 0) return;

    // Group by userId — one notification per user
    const byUser = new Map<string, { totalCoins: number; ids: string[] }>();
    for (const tx of expiring) {
        const entry = byUser.get(tx.userId) ?? { totalCoins: 0, ids: [] };
        entry.totalCoins += tx.remainingAmount ?? 0;
        entry.ids.push(tx.id);
        byUser.set(tx.userId, entry);
    }

    let notified = 0;
    for (const [userId, { totalCoins, ids }] of byUser) {
        await notificationClient.sendPush(
            userId,
            "⏰ Your coins are expiring soon!",
            `You have ${totalCoins} coins expiring in less than 6 hours. Use them to unlock episodes now!`,
            { type: "COIN_EXPIRY_REMINDER", screen: "coins" }
        );

        // Mark all matching transactions as reminded
        await prisma.coinTransaction.updateMany({
            where: { id: { in: ids } },
            data: { reminderSentAt: now },
        });

        notified++;
    }

    log.info({ notified }, "Coin expiry reminders sent");
}

// ── Notification 2: Streak break reminder ─────────────────────────────────

async function runStreakReminders(log: JobLogger) {
    const prisma = getPrisma();
    const now = new Date();

    // Users who claimed between 42h–48h ago: 6h left before streak breaks
    const reminderCutoff = new Date(now.getTime() - STREAK_REMINDER_HOURS * 60 * 60 * 1000);
    const breakCutoff = new Date(now.getTime() - STREAK_BREAK_HOURS * 60 * 60 * 1000);

    const dueStreaks = await prisma.userStreak.findMany({
        where: {
            lastClaimedAt: { gte: breakCutoff, lte: reminderCutoff },
            streakReminderSentAt: null,
        },
        select: { userId: true, currentDay: true },
        take: 1000,
    });

    if (dueStreaks.length === 0) return;

    let notified = 0;
    for (const streak of dueStreaks) {
        await notificationClient.sendPush(
            streak.userId,
            "🔥 Your streak is about to break!",
            `You're on Day ${streak.currentDay}! Claim your coins now — your streak breaks in 6 hours.`,
            { type: "STREAK_BREAK_REMINDER", screen: "streak" }
        );

        await prisma.userStreak.update({
            where: { userId: streak.userId },
            data: { streakReminderSentAt: now },
        });

        notified++;
    }

    log.info({ notified }, "Streak break reminders sent");
}

// ── Cron entry points ──────────────────────────────────────────────────────

async function runReminders(log: JobLogger) {
    await Promise.allSettled([
        runCoinExpiryReminders(log).catch(err => log.error({ err }, "coinExpiryReminders failed")),
        runStreakReminders(log).catch(err => log.error({ err }, "streakReminders failed")),
    ]);
}

export function startReminderCron(log: JobLogger) {
    if (timer) return;
    void runReminders(log);
    timer = setInterval(() => void runReminders(log), INTERVAL_MS);
    log.info("coinReminders cron started (30min interval)");
}

export function stopReminderCron() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
