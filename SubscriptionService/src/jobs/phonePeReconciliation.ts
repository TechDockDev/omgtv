import crypto from "crypto";
import { getPrisma } from "../lib/prisma";
import { getPhonePe } from "../lib/phonepe";
import { NotificationClient } from "../clients/notification-client";
import { trackSubscriptionEvent } from "../lib/analytics";
import { invalidateEntitlementCache } from "../lib/redis";

const notificationClient = new NotificationClient();

interface JobLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

const INTERVAL_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
const prisma = getPrisma();

export async function runPhonePeReconciliationPass(log: JobLogger): Promise<void> {
  const phonepe = getPhonePe();
  const now = new Date();
  let recoveries = 0;
  let windowWarnings = 0;
  let overdueNotifies = 0;

  // ── Pass A: EXECUTING rows > 10 min old ───────────────────────────────────
  // These are Execute calls where webhook was lost or is delayed
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000);
  const recheckThrottle = new Date(now.getTime() - 5 * 60 * 1000);

  const staleExecuting = await prisma.phonePeRedemption.findMany({
    where: {
      status: "EXECUTING",
      updatedAt: { lt: staleThreshold },
      OR: [
        { lastStatusCheckedAt: null },
        { lastStatusCheckedAt: { lt: recheckThrottle } },
      ],
    },
    include: { userSubscription: { include: { plan: true } } },
  });

  for (const redemption of staleExecuting) {
    try {
      const status = await phonepe.getRedemptionStatus(redemption.merchantOrderId, redemption.userId);
      await prisma.phonePeRedemption.update({
        where: { id: redemption.id },
        data: { lastStatusCheckedAt: now },
      });

      if (status.state === "COMPLETED") {
        recoveries++;
        await _handleSuccess(redemption, log);
        void trackSubscriptionEvent(redemption.userId, "phonepe_reconciliation_recovery", {
          provider: "phonepe", redemption_id: redemption.id,
          source: "reconciliation_pass_a",
        });
      } else if (status.state === "FAILED") {
        const attempts = redemption.executeAttempts + 1;
        const retryable = !["TRANSACTION_NOT_PERMITTED", "SUBSCRIPTION_INVALID",
          "SUBSCRIPTION_CANCELLED", "MANDATE_LIMIT_EXCEEDED"].includes(status.errorCode ?? "");
        const hasWindow = redemption.notifyWindowEnd && redemption.notifyWindowEnd > now;

        if (retryable && attempts < 3 && hasWindow) {
          await prisma.phonePeRedemption.update({
            where: { id: redemption.id },
            data: { status: "NOTIFIED", executeAttempts: attempts, lastError: status.errorCode },
          });
        } else {
          await _failRedemption(redemption, attempts, status.errorCode ?? "execute_failed", phonepe, log);
        }
      }
      // PENDING = still processing, leave as EXECUTING, check again next pass

    } catch (err: any) {
      log.warn({ msg: "phonepe_reconciliation: getRedemptionStatus failed (pass A)", redemptionId: redemption.id, error: err?.message });
    }
  }

  // ── Pass B: NOTIFIED rows with window closing in < 4h ─────────────────────
  // At risk of missing the 72h window — check if PhonePe already processed it
  const windowClosingSoon = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const recheckThrottleB = new Date(now.getTime() - 5 * 60 * 1000);

  const atRiskNotified = await prisma.phonePeRedemption.findMany({
    where: {
      status: "NOTIFIED",
      notifyWindowEnd: { lte: windowClosingSoon, gt: now },
      OR: [
        { lastStatusCheckedAt: null },
        { lastStatusCheckedAt: { lt: recheckThrottleB } },
      ],
    },
    include: { userSubscription: { include: { plan: true } } },
  });

  for (const redemption of atRiskNotified) {
    windowWarnings++;
    log.warn({
      msg: "phonepe_reconciliation: notify window closing soon",
      redemptionId: redemption.id,
      notifyWindowEnd: redemption.notifyWindowEnd,
    });

    try {
      const status = await phonepe.getRedemptionStatus(redemption.merchantOrderId, redemption.userId);
      await prisma.phonePeRedemption.update({
        where: { id: redemption.id },
        data: { lastStatusCheckedAt: now },
      });

      if (status.state === "COMPLETED") {
        recoveries++;
        await _handleSuccess(redemption, log);
        void trackSubscriptionEvent(redemption.userId, "phonepe_reconciliation_recovery", {
          provider: "phonepe", redemption_id: redemption.id, source: "reconciliation_pass_b",
        });
      }
      // If not COMPLETED, billing cron will attempt Execute on next 15-min pass
    } catch (err: any) {
      log.warn({ msg: "phonepe_reconciliation: getRedemptionStatus failed (pass B)", redemptionId: redemption.id, error: err?.message });
    }
  }

  // ── Pass C: Overdue PENDING_NOTIFY (server was down, cron missed window) ───
  // scheduledNotifyAt > 6h ago but still PENDING_NOTIFY
  const overdueThreshold = new Date(now.getTime() - 6 * 60 * 60 * 1000);

  const overdueRedemptions = await prisma.phonePeRedemption.findMany({
    where: {
      status: "PENDING_NOTIFY",
      scheduledNotifyAt: { lt: overdueThreshold },
      userSubscription: { status: "ACTIVE" },
    },
  });

  for (const redemption of overdueRedemptions) {
    overdueNotifies++;
    log.error({
      msg: "phonepe_reconciliation: overdue PENDING_NOTIFY — server was likely down",
      redemptionId: redemption.id,
      scheduledNotifyAt: redemption.scheduledNotifyAt,
      hoursOverdue: (now.getTime() - redemption.scheduledNotifyAt.getTime()) / (1000 * 60 * 60),
    });
    // Billing cron pass 1 will handle retry — just log for ops visibility
    // If notify window has completely passed, pass 3 in billing cron will catch it
  }

  log.info({
    msg: "phonepe_reconciliation_run",
    stale_executing_checked: staleExecuting.length,
    recoveries,
    window_warnings: windowWarnings,
    overdue_notifies: overdueNotifies,
  });

  if (recoveries > 0) {
    void trackSubscriptionEvent("system", "phonepe_reconciliation_summary", {
      provider: "phonepe",
      recoveries,
      window_warnings: windowWarnings,
    });
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function _handleSuccess(redemption: any, log: JobLogger): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.phonePeRedemption.updateMany({
      where: { id: redemption.id, status: { not: "SUCCESS" } },
      data: { status: "SUCCESS" },
    });
    if (locked.count === 0) return; // webhook already processed

    const sub = redemption.userSubscription;
    const durationDays = sub.plan?.durationDays ?? 30;
    const newEndsAt = new Date(sub.endsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

    await tx.userSubscription.update({
      where: { id: sub.id },
      data: { endsAt: newEndsAt, status: "ACTIVE" },
    });

    try {
      await tx.phonePeRedemption.create({
        data: {
          userId: redemption.userId,
          userSubscriptionId: sub.id,
          merchantSubscriptionId: redemption.merchantSubscriptionId,
          merchantOrderId: `OMGTV_ORD_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
          amount: sub.plan?.pricePaise ?? redemption.amount,
          isTrialCycle: false,
          cycleNumber: redemption.cycleNumber + 1,
          mandateMaxAmount: redemption.mandateMaxAmount,
          scheduledNotifyAt: new Date(newEndsAt.getTime() - 49 * 60 * 60 * 1000),
          status: "PENDING_NOTIFY",
        },
      });
    } catch { /* unique constraint — next cycle already exists */ }
  });

  await invalidateEntitlementCache(redemption.userId);

  void notificationClient.sendPush(redemption.userId, "Subscription Renewed",
    "Your subscription has been renewed successfully!", { type: "SUBSCRIPTION_RENEWED" });

  void trackSubscriptionEvent(redemption.userId, "subscription_renewed", {
    plan_id: redemption.userSubscription.planId ?? "",
    provider: "phonepe",
    cycle_number: redemption.cycleNumber,
    source: "reconciliation",
  });

  log.info({ msg: "phonepe_reconciliation: recovered SUCCESS", redemptionId: redemption.id });
}

async function _failRedemption(
  redemption: any,
  attempts: number,
  reason: string,
  phonepe: ReturnType<typeof getPhonePe>,
  log: JobLogger
): Promise<void> {
  await prisma.phonePeRedemption.update({
    where: { id: redemption.id },
    data: { status: "FAILED", executeAttempts: attempts, lastError: reason },
  });
  await prisma.userSubscription.update({
    where: { id: redemption.userSubscriptionId },
    data: { status: "CANCELED" },
  });
  try {
    await phonepe.cancelSubscription(redemption.merchantSubscriptionId, redemption.userId);
  } catch {}

  await invalidateEntitlementCache(redemption.userId);

  void notificationClient.sendPush(redemption.userId, "Payment Failed",
    "We couldn't renew your subscription. Please resubscribe to continue watching.",
    { type: "SUBSCRIPTION_PAYMENT_FAILED" });

  void trackSubscriptionEvent(redemption.userId, "subscription_payment_failed", {
    provider: "phonepe", reason, attempts,
  });

  log.error({ msg: "phonepe_reconciliation: redemption FAILED", redemptionId: redemption.id, reason });
}

// ── Cron lifecycle ──────────────────────────────────────────────────────────

export function startPhonePeReconciliationCron(log: JobLogger): void {
  if (timer) return;
  timer = setInterval(() => {
    void runPhonePeReconciliationPass(log).catch(err =>
      log.error({ msg: "phonepe_reconciliation_cron: unhandled error", err })
    );
  }, INTERVAL_MS);
  log.info("phonePeReconciliation cron started (15 min interval)");
}

export function stopPhonePeReconciliationCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
