import crypto from "crypto";
import { getPrisma } from "../lib/prisma";
import { getPhonePe, isRetryablePhonePeError, NON_RETRYABLE_CODES } from "../lib/phonepe";
import { NotificationClient } from "../clients/notification-client";
import { trackSubscriptionEvent } from "../lib/analytics";
import { invalidateEntitlementCache } from "../lib/redis";

const notificationClient = new NotificationClient();

interface JobLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

// Stats tracked per cron run for analytics
interface CronRunStats {
  pass1_triggered: number;
  pass1_success: number;
  pass1_failed: number;
  pass2_triggered: number;
  pass2_success: number;
  pass2_failed: number;
  pass2_retryable_fail: number;
  pass3_expired: number;
  pass4_stale_executing: number;
  duration_ms: number;
}

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let timer: ReturnType<typeof setInterval> | null = null;
const prisma = getPrisma();

export async function runPhonePeBillingPass(log: JobLogger): Promise<CronRunStats> {
  const start = Date.now();
  const stats: CronRunStats = {
    pass1_triggered: 0, pass1_success: 0, pass1_failed: 0,
    pass2_triggered: 0, pass2_success: 0, pass2_failed: 0, pass2_retryable_fail: 0,
    pass3_expired: 0,
    pass4_stale_executing: 0,
    duration_ms: 0,
  };

  const phonepe = getPhonePe();
  const now = new Date();

  // ── Pass 1: Trigger Notify ─────────────────────────────────────────────────
  // Find redemptions that should be notified now (49h before next_due)
  const toNotify = await prisma.phonePeRedemption.findMany({
    where: {
      status: "PENDING_NOTIFY",
      scheduledNotifyAt: { lte: now },
      userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
    },
    include: { userSubscription: true },
  });

  for (const redemption of toNotify) {
    stats.pass1_triggered++;

    // Mandate ceiling guard — never charge more than mandate allows
    if (redemption.amount > redemption.mandateMaxAmount) {
      log.error({
        msg: "phonepe_billing: amount exceeds mandateMaxAmount — marking FAILED",
        redemptionId: redemption.id,
        amount: redemption.amount,
        mandateMaxAmount: redemption.mandateMaxAmount,
      });
      await _failRedemption(redemption, redemption.executeAttempts, "amount_exceeds_mandate_max", phonepe, log);
      void trackSubscriptionEvent(redemption.userId, "phonepe_mandate_exceeded", {
        provider: "phonepe", redemption_id: redemption.id,
      });
      stats.pass1_failed++;
      continue;
    }

    // Warn if we're more than 6h overdue (means cron was down)
    const overdueHours = (now.getTime() - redemption.scheduledNotifyAt.getTime()) / (1000 * 60 * 60);
    if (overdueHours > 6) {
      log.warn({ msg: "phonepe_billing: overdue PENDING_NOTIFY", redemptionId: redemption.id, overdueHours });
    }

    try {
      const expireAt = now.getTime() + 72 * 60 * 60 * 1000;

      await phonepe.notifyRedemption({
        userId: redemption.userId,
        merchantSubscriptionId: redemption.merchantSubscriptionId,
        merchantOrderId: redemption.merchantOrderId,
        amount: redemption.amount,
        expireAt,
      });

      const notifiedAt = new Date();
      await prisma.phonePeRedemption.update({
        where: { id: redemption.id },
        data: {
          status: "NOTIFIED",
          notifiedAt,
          notifyWindowEnd: new Date(notifiedAt.getTime() + 72 * 60 * 60 * 1000),
        },
      });

      log.info({ msg: "phonepe_billing: notify sent", redemptionId: redemption.id, merchantOrderId: redemption.merchantOrderId });
      void trackSubscriptionEvent(redemption.userId, "phonepe_notify_success", {
        provider: "phonepe", redemption_id: redemption.id, cycle_number: redemption.cycleNumber,
      });
      stats.pass1_success++;
    } catch (err: any) {
      log.error({ msg: "phonepe_billing: notify failed", redemptionId: redemption.id, error: err?.message });
      void trackSubscriptionEvent(redemption.userId, "phonepe_notify_failed", {
        provider: "phonepe", redemption_id: redemption.id, error: err?.message,
      });
      stats.pass1_failed++;
      // Leave as PENDING_NOTIFY — next cron run will retry
    }
  }

  // ── Pass 2: Execute debit ──────────────────────────────────────────────────
  // autoDebit=true on notify means PhonePe auto-executes the debit — no manual execute needed.
  // Pass 2 is kept as a safety net ONLY for rows stuck in NOTIFIED after window is 90% elapsed
  // (i.e. PhonePe's auto-debit failed silently and no webhook arrived).
  // Normal path: webhook fires subscription.redemption.order.completed → sets SUCCESS → Pass 2 skips it.
  const coolingEnd = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const windowBuffer = new Date(now.getTime() + 2 * 60 * 60 * 1000); // need 2h buffer

  const toExecute = await prisma.phonePeRedemption.findMany({
    where: {
      status: "NOTIFIED",
      notifiedAt: { lte: coolingEnd },
      notifyWindowEnd: { gt: windowBuffer },
      userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
    },
    include: { userSubscription: { include: { plan: true } } },
  });

  for (const redemption of toExecute) {
    stats.pass2_triggered++;

    // Optimistic lock — prevents double-charge if two cron instances run simultaneously
    const locked = await prisma.phonePeRedemption.updateMany({
      where: { id: redemption.id, status: "NOTIFIED" },
      data: { status: "EXECUTING" },
    });
    if (locked.count === 0) {
      log.info({ msg: "phonepe_billing: execute lock missed (another instance)", redemptionId: redemption.id });
      continue;
    }

    try {
      await phonepe.executeRedemption({
        userId: redemption.userId,
        merchantOrderId: redemption.merchantOrderId,
      });

      // Execute accepted — webhook or reconciliation will confirm SUCCESS and extend sub
      log.info({ msg: "phonepe_billing: execute called", redemptionId: redemption.id, merchantOrderId: redemption.merchantOrderId });
      stats.pass2_success++;
      // Do NOT mark SUCCESS here — wait for webhook confirmation
      // Leave as EXECUTING so reconciliation can verify via getRedemptionStatus

    } catch (err: any) {
      const attempts = redemption.executeAttempts + 1;
      const retryable = isRetryablePhonePeError(err);
      const windowSoon = redemption.notifyWindowEnd
        ? redemption.notifyWindowEnd.getTime() - now.getTime() < 2 * 60 * 60 * 1000
        : false;

      log.warn({
        msg: "phonepe_billing: execute failed",
        redemptionId: redemption.id,
        error: err?.message,
        errorCode: err?.code,
        attempts,
        retryable,
        windowSoon,
      });

      if (!retryable || attempts >= 3 || windowSoon) {
        // Permanent failure
        await _failRedemption(redemption, attempts, err?.code ?? err?.message, phonepe, log);
        stats.pass2_failed++;
        void trackSubscriptionEvent(redemption.userId, "phonepe_execute_failed", {
          provider: "phonepe", redemption_id: redemption.id, error_code: err?.code,
          attempts, final: true,
        });
      } else {
        // Retryable — revert EXECUTING back to NOTIFIED for next pass
        await prisma.phonePeRedemption.update({
          where: { id: redemption.id },
          data: { status: "NOTIFIED", executeAttempts: attempts, lastError: err?.code ?? err?.message },
        });
        stats.pass2_retryable_fail++;
        void trackSubscriptionEvent(redemption.userId, "phonepe_execute_retry", {
          provider: "phonepe", redemption_id: redemption.id, attempt_number: attempts,
        });
      }
    }
  }

  // ── Pass 3: Expired windows ────────────────────────────────────────────────
  // NOTIFIED rows whose 72h window has closed without a successful execute
  const expiredNotified = await prisma.phonePeRedemption.findMany({
    where: {
      status: "NOTIFIED",
      notifyWindowEnd: { lt: now },
    },
  });

  for (const redemption of expiredNotified) {
    stats.pass3_expired++;
    log.error({
      msg: "phonepe_billing: notify window expired — marking FAILED",
      redemptionId: redemption.id,
      merchantOrderId: redemption.merchantOrderId,
    });
    await _failRedemption(redemption, redemption.executeAttempts, "window_expired", phonepe, log);
    void trackSubscriptionEvent(redemption.userId, "phonepe_window_expired", {
      provider: "phonepe", redemption_id: redemption.id,
    });
  }

  // PENDING_NOTIFY rows where the subscription is no longer active — notify never succeeded
  // notifyWindowEnd is NULL on these rows so the NOTIFIED check above never catches them
  const orphanedNotify = await prisma.phonePeRedemption.findMany({
    where: {
      status: "PENDING_NOTIFY",
      scheduledNotifyAt: { lt: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
      userSubscription: { status: { in: ["EXPIRED", "CANCELED"] } },
    },
  });

  for (const redemption of orphanedNotify) {
    stats.pass3_expired++;
    log.error({
      msg: "phonepe_billing: PENDING_NOTIFY orphaned — subscription expired before notify succeeded",
      redemptionId: redemption.id,
      scheduledNotifyAt: redemption.scheduledNotifyAt,
    });
    await prisma.phonePeRedemption.update({
      where: { id: redemption.id },
      data: { status: "FAILED", lastError: "notify_never_succeeded" },
    });
    void trackSubscriptionEvent(redemption.userId, "phonepe_notify_orphaned", {
      provider: "phonepe", redemption_id: redemption.id,
    });
  }

  // ── Pass 4: Stale EXECUTING rows ───────────────────────────────────────────
  // Execute was called but webhook hasn't arrived — check status via API
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000); // 10 min
  const recheckThrottle = new Date(now.getTime() - 5 * 60 * 1000); // don't recheck < 5 min

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
    stats.pass4_stale_executing++;
    log.info({ msg: "phonepe_billing: checking stale EXECUTING", redemptionId: redemption.id });

    try {
      const status = await phonepe.getRedemptionStatus(redemption.merchantOrderId, redemption.userId);
      await prisma.phonePeRedemption.update({
        where: { id: redemption.id },
        data: { lastStatusCheckedAt: now },
      });

      if (status.state === "COMPLETED") {
        await _handleRedemptionSuccess(redemption, log);
        void trackSubscriptionEvent(redemption.userId, "phonepe_reconciliation_recovery", {
          provider: "phonepe", redemption_id: redemption.id, source: "billing_cron",
        });
      } else if (status.state === "FAILED") {
        const attempts = redemption.executeAttempts + 1;
        const retryable = status.errorCode ? !NON_RETRYABLE_CODES.has(status.errorCode) : true;

        if (retryable && attempts < 3 && redemption.notifyWindowEnd && redemption.notifyWindowEnd > now) {
          await prisma.phonePeRedemption.update({
            where: { id: redemption.id },
            data: { status: "NOTIFIED", executeAttempts: attempts, lastError: status.errorCode },
          });
        } else {
          await _failRedemption(redemption, attempts, status.errorCode ?? "execute_failed", phonepe, log);
        }
      } else if (redemption.lastStatusCheckedAt !== null) {
        // PhonePe returned PENDING (or unknown state) AND we have already checked once before.
        // This means execute was either never received or is stuck >15 min — safe to reset and retry.
        // Same merchantOrderId makes the retry idempotent on PhonePe's side.
        if (redemption.notifyWindowEnd && redemption.notifyWindowEnd > now) {
          log.warn({
            msg: "phonepe_billing: EXECUTING stuck — execute likely not received, resetting to NOTIFIED",
            redemptionId: redemption.id,
            phonePeState: status.state,
          });
          await prisma.phonePeRedemption.update({
            where: { id: redemption.id },
            data: { status: "NOTIFIED", lastError: "execute_unconfirmed_reset" },
          });
        } else {
          await _failRedemption(redemption, redemption.executeAttempts, "execute_unconfirmed_window_closed", phonepe, log);
        }
      }
      // PENDING on first check = execute sent, give bank time to confirm

    } catch (err: any) {
      const windowExpired = redemption.notifyWindowEnd && redemption.notifyWindowEnd < now;
      if (windowExpired) {
        log.error({ msg: "phonepe_billing: getRedemptionStatus failed AND notify window expired — EXECUTING row needs manual investigation", redemptionId: redemption.id, merchantOrderId: redemption.merchantOrderId, notifyWindowEnd: redemption.notifyWindowEnd, error: err?.message });
      } else {
        log.warn({ msg: "phonepe_billing: getRedemptionStatus failed", redemptionId: redemption.id, error: err?.message });
      }
    }
  }

  stats.duration_ms = Date.now() - start;

  log.info({
    msg: "phonepe_billing_cron_run",
    ...stats,
  });

  return stats;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function _handleRedemptionSuccess(
  redemption: any,
  log: JobLogger
): Promise<void> {
  let didProcess = false;
  await prisma.$transaction(async (tx) => {
    const locked = await tx.phonePeRedemption.updateMany({
      where: { id: redemption.id, status: { not: "SUCCESS" } },
      data: { status: "SUCCESS" },
    });
    if (locked.count === 0) return; // already processed — return from callback only
    didProcess = true;

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
    } catch (err: any) {
      if (!err?.message?.includes("Unique constraint")) {
        log.error({ msg: "phonepe_billing: failed to create next cycle redemption — manual check needed", redemptionId: redemption.id, error: err?.message });
      }
    }
  });

  if (!didProcess) return; // another path already handled — do not send duplicate push

  await invalidateEntitlementCache(redemption.userId);

  void notificationClient.sendPush(redemption.userId, "Subscription Renewed",
    "Your subscription has been renewed successfully!", { type: "SUBSCRIPTION_RENEWED" });

  void trackSubscriptionEvent(redemption.userId, "subscription_renewed", {
    plan_id: redemption.userSubscription.planId ?? "",
    provider: "phonepe",
    cycle_number: redemption.cycleNumber,
    source: "billing_cron",
  });

  log.info({ msg: "phonepe_billing: redemption SUCCESS", redemptionId: redemption.id });
}

async function _failRedemption(
  redemption: any,
  attempts: number,
  reason: string,
  phonepe: ReturnType<typeof getPhonePe>,
  log: JobLogger
): Promise<void> {
  // Atomic + idempotent via interactive transaction:
  // Only cancel if redemption is not already SUCCESS/FAILED.
  // The conditional check must be INSIDE the transaction — array syntax runs all ops unconditionally.
  let didFail = false;
  await prisma.$transaction(async (tx) => {
    const result = await tx.phonePeRedemption.updateMany({
      where: { id: redemption.id, status: { notIn: ["SUCCESS", "FAILED"] } },
      data: { status: "FAILED", executeAttempts: attempts, lastError: reason },
    });
    if (result.count === 0) return; // already SUCCESS or FAILED — leave subscription alone
    await tx.userSubscription.update({
      where: { id: redemption.userSubscriptionId },
      data: { status: "CANCELED" },
    });
    didFail = true;
  });

  if (!didFail) {
    log.warn({ msg: "phonepe_billing: _failRedemption skipped — redemption already SUCCESS or FAILED", redemptionId: redemption.id });
    return;
  }

  try {
    await phonepe.cancelSubscription(redemption.merchantSubscriptionId, redemption.userId);
  } catch (cancelErr: any) {
    log.warn({ msg: "phonepe_billing: cancelSubscription failed", error: cancelErr?.message });
  }

  await invalidateEntitlementCache(redemption.userId);

  void notificationClient.sendPush(redemption.userId, "Payment Failed",
    "We couldn't renew your subscription. Please resubscribe to continue watching.",
    { type: "SUBSCRIPTION_PAYMENT_FAILED" });

  void trackSubscriptionEvent(redemption.userId, "subscription_payment_failed", {
    provider: "phonepe", reason, attempts,
  });

  log.error({ msg: "phonepe_billing: redemption FAILED", redemptionId: redemption.id, reason, attempts });
}

// ── Cron lifecycle ──────────────────────────────────────────────────────────

export function startPhonePeBillingCron(log: JobLogger): void {
  if (timer) return;
  void runPhonePeBillingPass(log).catch(err =>
    log.error({ msg: "phonepe_billing_cron: unhandled error on startup run", err })
  );
  timer = setInterval(() => {
    void runPhonePeBillingPass(log).catch(err =>
      log.error({ msg: "phonepe_billing_cron: unhandled error", err })
    );
  }, INTERVAL_MS);
  log.info("phonepeBilling cron started (15 min interval)");
}

export function stopPhonePeBillingCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
