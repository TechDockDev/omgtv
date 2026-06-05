import { getPrisma } from "../lib/prisma";
import { getPhonePe } from "../lib/phonepe";
import { trackSubscriptionEvent } from "../lib/analytics";
import { activatePhonePeSetupOrder } from "../services/phonePeActivation";

interface JobLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

// Runs more often than the 15-min redemption crons: setup orders expire fast (15 min
// checkout window), so a missed webhook needs quicker recovery for good UX.
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let timer: ReturnType<typeof setInterval> | null = null;
const prisma = getPrisma();

// Give the app-driven verify endpoint and the user time to finish before we poll.
const MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes old before first poll
// PhonePe checkout order expires after 15 min (expireAfter: 900). A PENDING order past
// this has no chance of completing — fail it so it drops out of the polling set.
const EXPIRY_MS = 20 * 60 * 1000; // 20 minutes (15 min window + buffer)
// Safety scan floor — don't sweep ancient rows on every run.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Recovers PhonePe SETUP orders (first purchase / mandate creation) when BOTH the
 * app's /purchase/verify call AND the setup webhook were missed — e.g. the server was
 * down or the app crashed right after payment.
 *
 * A PENDING phonepe Transaction is always a setup order: renewals are created already
 * SUCCESS/FAILED, and coin purchases use a separate model. So the filter is simply
 * provider=phonepe + status=PENDING.
 */
export async function runPhonePeSetupReconciliationPass(log: JobLogger): Promise<void> {
  const phonepe = getPhonePe();
  const now = new Date();
  const minAge = new Date(now.getTime() - MIN_AGE_MS);
  const maxAge = new Date(now.getTime() - MAX_AGE_MS);

  const pending = await prisma.transaction.findMany({
    where: {
      provider: "phonepe",
      status: "PENDING",
      createdAt: { lt: minAge, gt: maxAge },
    },
  });

  let recovered = 0;
  let failed = 0;
  let stillPending = 0;
  let expired = 0;

  for (const tx of pending) {
    const meta = (tx.metadata ?? {}) as Record<string, unknown>;
    const merchantOrderId = typeof meta.merchantOrderId === "string" ? meta.merchantOrderId : undefined;
    const merchantSubscriptionId =
      (typeof meta.merchantSubscriptionId === "string" ? meta.merchantSubscriptionId : undefined) ??
      tx.subscriptionId ??
      undefined;

    if (!merchantOrderId || !merchantSubscriptionId) {
      log.warn({ msg: "phonepe_setup_recon: transaction missing merchantOrderId/merchantSubscriptionId", txId: tx.id });
      continue;
    }

    try {
      const status = await phonepe.getRedemptionStatus(merchantOrderId, tx.userId);

      if (status.state === "COMPLETED") {
        const result = await activatePhonePeSetupOrder({ transaction: tx, merchantOrderId, merchantSubscriptionId, log });

        if (result.kind === "mandate_failed") {
          await prisma.transaction.update({
            where: { id: tx.id },
            data: { status: "FAILED", failureReason: `mandate_${result.state}` },
          });
          failed++;
        } else {
          recovered++;
          void trackSubscriptionEvent(tx.userId, "phonepe_setup_reconciliation_recovery", {
            provider: "phonepe", transaction_id: tx.id, result: result.kind,
          });
        }
      } else if (status.state === "FAILED") {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { status: "FAILED", failureReason: status.errorCode ?? "Setup order failed" },
        });
        failed++;
        void trackSubscriptionEvent(tx.userId, "phonepe_payment_failed", {
          provider: "phonepe", plan_id: tx.planId ?? "", is_trial: !!tx.trialPlanId,
          error_code: status.errorCode, stage: "setup_order_reconciliation",
        });
      } else {
        // PENDING on PhonePe's side
        if (now.getTime() - tx.createdAt.getTime() > EXPIRY_MS) {
          // Checkout window has closed without payment — user never completed it
          await prisma.transaction.update({
            where: { id: tx.id },
            data: { status: "FAILED", failureReason: "setup_order_expired" },
          });
          expired++;
        } else {
          stillPending++;
        }
      }
    } catch (err: any) {
      // Transient error or MERCHANT_ORDER_MAPPING_NOT_FOUND — log and retry next pass
      log.warn({ msg: "phonepe_setup_recon: getOrderStatus failed", txId: tx.id, merchantOrderId, error: err?.message });
    }
  }

  log.info({
    msg: "phonepe_setup_reconciliation_run",
    checked: pending.length,
    recovered,
    failed,
    expired,
    still_pending: stillPending,
  });
}

// ── Cron lifecycle ──────────────────────────────────────────────────────────

export function startPhonePeSetupReconciliationCron(log: JobLogger): void {
  if (timer) return;
  void runPhonePeSetupReconciliationPass(log).catch(err =>
    log.error({ msg: "phonepe_setup_reconciliation_cron: unhandled error on startup run", err })
  );
  timer = setInterval(() => {
    void runPhonePeSetupReconciliationPass(log).catch(err =>
      log.error({ msg: "phonepe_setup_reconciliation_cron: unhandled error", err })
    );
  }, INTERVAL_MS);
  log.info("phonePeSetupReconciliation cron started (5 min interval)");
}

export function stopPhonePeSetupReconciliationCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
