import crypto from "crypto";
import type { Transaction } from "@prisma/client";
import { getPrisma } from "../lib/prisma";
import { getPhonePe } from "../lib/phonepe";
import { invalidateEntitlementCache } from "../lib/redis";
import { trackSubscriptionEvent } from "../lib/analytics";
import { NotificationClient } from "../clients/notification-client";

const notificationClient = new NotificationClient();

// ₹1,000 ceiling — must match what was sent at mandate setup
const MANDATE_MAX_AMOUNT = 100000;

interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export type PhonePeActivationResult =
  | { kind: "activated" }
  | { kind: "already_active" }
  | { kind: "mandate_failed"; state: string };

/**
 * Activates a PhonePe subscription after the setup order is confirmed COMPLETED.
 *
 * Shared by:
 *   - POST /purchase/verify     (primary path — app-driven, immediately after payment)
 *   - phonePeSetupReconciliation (fallback cron — recovers orders where verify + webhook were both missed)
 *
 * The CALLER is responsible for confirming the order state is COMPLETED first
 * (via getRedemptionStatus). This function handles everything after that:
 * mandate resolution, idempotency, subscription creation, cycle scheduling,
 * cache invalidation, analytics and push.
 *
 * Idempotent — safe to call multiple times for the same transaction. Returns
 * `already_active` if another path (verify, webhook, or a prior cron run) won the race.
 */
export async function activatePhonePeSetupOrder(params: {
  transaction: Transaction;
  merchantOrderId: string;
  merchantSubscriptionId: string;
  log: Logger;
}): Promise<PhonePeActivationResult> {
  const { transaction, merchantOrderId, merchantSubscriptionId, log } = params;
  const prisma = getPrisma();
  const userId = transaction.userId;

  // Resolve PhonePe's internal subscription ID (best-effort — order confirmation is authoritative).
  // Mandate may still be ACTIVATION_IN_PROGRESS; that's fine, the payment is already confirmed.
  let phonePeSubscriptionId = merchantSubscriptionId;
  try {
    const ppStatus = await getPhonePe().getSubscriptionStatus(merchantSubscriptionId, userId);
    phonePeSubscriptionId = ppStatus.subscriptionId ?? merchantSubscriptionId;
    if (ppStatus.state === "FAILED" || ppStatus.state === "CANCELLED") {
      return { kind: "mandate_failed", state: ppStatus.state };
    }
  } catch (err: any) {
    log.warn({ err, merchantSubscriptionId }, "PhonePe getSubscriptionStatus failed — proceeding on order confirmation");
  }

  // Idempotency: another device/path already created an active subscription
  const existingSub = await prisma.userSubscription.findFirst({
    where: { userId, provider: "phonepe", status: { in: ["ACTIVE", "TRIAL", "PAUSED"] } },
  });
  if (existingSub) {
    // Cancel the losing mandate (different merchantSubscriptionId means a different device won)
    if (existingSub.phonePeSubscriptionId !== merchantSubscriptionId) {
      try { await getPhonePe().cancelSubscription(merchantSubscriptionId, userId); } catch { /* best-effort */ }
    }
    return { kind: "already_active" };
  }

  // Expire existing trial if this is an upgrade
  const existingTrialSub = await prisma.userSubscription.findFirst({
    where: { userId, status: { in: ["TRIAL", "CANCELED"] }, trialPlanId: { not: null }, endsAt: { gt: new Date() } },
  });
  if (existingTrialSub) {
    await prisma.userSubscription.update({ where: { id: existingTrialSub.id }, data: { status: "EXPIRED", endsAt: new Date() } });
    if (existingTrialSub.phonePeSubscriptionId) {
      try { await getPhonePe().cancelSubscription(existingTrialSub.phonePeSubscriptionId, userId); } catch { /* best-effort */ }
    }
    // Cancel pending redemptions for old trial
    await prisma.phonePeRedemption.updateMany({
      where: { userSubscriptionId: existingTrialSub.id, status: { in: ["PENDING_NOTIFY", "NOTIFIED"] } },
      data: { status: "FAILED", lastError: "Superseded by plan upgrade" },
    });
  }

  await prisma.transaction.update({ where: { id: transaction.id }, data: { status: "SUCCESS" } });

  const trialPlanId = transaction.trialPlanId;
  const startsAt = new Date();
  let endsAt = new Date();

  if (trialPlanId) {
    const trialPlan = await prisma.trialPlan.findUnique({ where: { id: trialPlanId } });
    if (trialPlan) endsAt = new Date(Date.now() + trialPlan.durationDays * 24 * 60 * 60 * 1000);
  } else {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
    if (plan) endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
  }

  let newSub;
  try {
    newSub = await prisma.userSubscription.create({
      data: {
        userId,
        planId: transaction.planId,
        trialPlanId,
        status: trialPlanId ? "TRIAL" : "ACTIVE",
        provider: "phonepe",
        phonePeSubscriptionId,
        mandateMaxAmount: MANDATE_MAX_AMOUNT,
        razorpayOrderId: null,
        transactionId: transaction.id,
        startsAt,
        endsAt,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Concurrent path won the race — subscription already created
      await invalidateEntitlementCache(userId);
      return { kind: "already_active" };
    }
    throw err;
  }

  // First payment already done by the setup order — mark cycle 1 SUCCESS.
  // try/catch: concurrent callers would hit the unique constraint on merchantOrderId
  try {
    await prisma.phonePeRedemption.create({
      data: {
        userId,
        userSubscriptionId: newSub.id,
        merchantSubscriptionId,
        merchantOrderId,
        amount: transaction.amountPaise,
        isTrialCycle: !!trialPlanId,
        cycleNumber: 1,
        mandateMaxAmount: 50000,
        scheduledNotifyAt: new Date(0), // past — already done
        status: "SUCCESS",
        notifiedAt: new Date(),
        notifyWindowEnd: new Date(),
      },
    });
  } catch { /* duplicate merchantOrderId — concurrent path, safe to ignore */ }

  // Schedule cycle 2 (first auto-renewal)
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
  if (plan) {
    const scheduledNotifyAt = new Date(endsAt.getTime() - 49 * 60 * 60 * 1000);
    try {
      await prisma.phonePeRedemption.create({
        data: {
          userId,
          userSubscriptionId: newSub.id,
          merchantSubscriptionId,
          merchantOrderId: `OMGTV_ORD_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
          amount: plan.pricePaise,
          isTrialCycle: false,
          cycleNumber: 2,
          mandateMaxAmount: MANDATE_MAX_AMOUNT,
          scheduledNotifyAt,
          status: "PENDING_NOTIFY",
        },
      });
    } catch (err: any) {
      if (!err?.message?.includes("Unique constraint")) {
        log.error({ msg: "phonepe activation: failed to create cycle 2 redemption — manual check needed", userId, error: err?.message });
      }
    }
  }

  await invalidateEntitlementCache(userId);
  const isTrial = !!trialPlanId;

  if (isTrial) {
    const trialDays = Math.round((endsAt.getTime() - startsAt.getTime()) / (1000 * 86400));
    void trackSubscriptionEvent(userId, "trial_activated", { plan_id: transaction.planId ?? "", trial_days: trialDays, provider: "phonepe" });
    const priorTrials = await prisma.userSubscription.count({ where: { userId, trialPlanId: { not: null }, id: { not: newSub.id } } });
    if (priorTrials === 0) void trackSubscriptionEvent(userId, "first_trial_purchased", { plan_id: transaction.planId ?? "", trial_days: trialDays, provider: "phonepe" });
    await notificationClient.sendPush(userId, "Free Trial Activated!", `Your ${trialDays} day trial has been activated.`, { type: "SUBSCRIPTION_ACTIVATED" });
  } else {
    void trackSubscriptionEvent(userId, "subscription_activated", { plan_id: transaction.planId ?? "", provider: "phonepe" });
    const priorPaidSubs = await prisma.userSubscription.count({ where: { userId, trialPlanId: null, id: { not: newSub.id } } });
    if (priorPaidSubs === 0) void trackSubscriptionEvent(userId, "first_subscription_purchased", { plan_id: transaction.planId ?? "", provider: "phonepe" });
    await notificationClient.sendPush(userId, "Subscription Activated", "Your subscription is now active. Enjoy unlimited content!", { type: "SUBSCRIPTION_ACTIVATED" });
  }

  return { kind: "activated" };
}
