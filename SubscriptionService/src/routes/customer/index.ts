import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { getPrisma } from "../../lib/prisma";
import { invalidateEntitlementCache, getRedis } from "../../lib/redis";
import { CoinService } from "../../services/coinService";
import { StreakService } from "../../services/streakService";
import { ContentClient } from "../../clients/content-client";
import { NotificationClient } from "../../clients/notification-client";
import { TransactionSource, CoinTransactionType } from "@prisma/client";
import { loadConfig } from "../../config";
import { getRazorpay } from "../../lib/razorpay";
import { getPhonePe } from "../../lib/phonepe";
import { trackSubscriptionEvent } from "../../lib/analytics";
const coinService = new CoinService();
const streakService = new StreakService();
const contentClient = new ContentClient();
const notificationClient = new NotificationClient();
const config = loadConfig();

const purchaseIntentSchema = z.object({
  planId: z.string().uuid(),
  deviceId: z.string().optional(),
  isTrial: z.boolean().optional(),
  provider: z.enum(["razorpay", "phonepe"]).default("razorpay").optional(),
});

export default async function customerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get("/plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (request) => {
    const { userId } = request.query as { userId?: string };

    const [globalTrialPlan, anyTrialPlan, plans, appConfig] = await Promise.all([
      prisma.trialPlan.findFirst({ where: { isActive: true } }),
      prisma.trialPlan.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.subscriptionPlan.findMany({ where: { isActive: true, deletedAt: null }, orderBy: { pricePaise: "asc" } }),
      (prisma as any).subscriptionGlobalConfig.findFirst({ where: { id: 1 } }),
    ]);

    let hasUsedTrial = false;
    if (appConfig?.restrictRepeatTrials && userId) {
      const previousTrial = await prisma.userSubscription.findFirst({
        where: { userId, trialPlanId: { not: null } },
      });
      hasUsedTrial = !!previousTrial;
    }

    const activeTrial = globalTrialPlan ?? anyTrialPlan;

    const formattedPlans = plans.map(plan => {
      const durationMonths = Math.round(plan.durationDays / 30);
      const price = Math.floor(plan.pricePaise / 100);
      const pricePerMonth = durationMonths > 0 ? Math.floor(price / durationMonths) : price;

      return {
        ...plan,
        duration: `${durationMonths}_months`,
        durationLabel: `${durationMonths} Months`,
        durationMonths,
        price,
        pricePerMonth,
        promoVideoUrl: (plan as any).promoVideoUrl,
      };
    });

    return {
      success: true,
      statusCode: 200,
      userMessage: "Plans retrieved successfully",
      developerMessage: "Public plans retrieved",
      hasUsedTrial,
      trialPlan: activeTrial ? {
        id: activeTrial.id,
        trialPricePaise: activeTrial.trialPricePaise,
        cancelledTrialPricePaise: (activeTrial as any).cancelledTrialPricePaise,
        durationDays: activeTrial.durationDays,
        isAutoDebit: activeTrial.isAutoDebit,
        isEligible: !hasUsedTrial && !!globalTrialPlan,
      } : null,
      promoVideoUrl: appConfig?.promoVideoUrl || null,
      data: formattedPlans,
    };
  });

  app.get("/trial-plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (request) => {
    const { userId } = request.query as { userId?: string };

    const trialPlans = await prisma.trialPlan.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    const hasUsedTrial = false;

    const formattedTrialPlans = trialPlans.map(tp => ({
      id: tp.id,
      trialPricePaise: tp.trialPricePaise,
      cancelledTrialPricePaise: (tp as any).cancelledTrialPricePaise,
      durationDays: tp.durationDays,
      reminderDays: tp.reminderDays,
      isAutoDebit: tp.isAutoDebit,
      isEligible: !hasUsedTrial
    }));

    return {
      success: true,
      statusCode: 200,
      userMessage: "Trial plans retrieved successfully",
      developerMessage: "Active trial plans retrieved",
      hasUsedTrial,
      data: formattedTrialPlans,
    };
  });


  app.get("/me/subscription", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };

    // 1. First check for an active/trial subscription that hasn't expired
    let subscription = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIAL", "CANCELED", "PAUSED"] },
        endsAt: { gt: new Date() }
      },
      orderBy: { startsAt: "desc" },
      include: {
        plan: true,
        trialPlan: true
      },
    });

    // 2. If no active subscription found, check if there's an expired trial
    //    that has a Razorpay subscription which may have auto-renewed.
    //    This bridges the gap between trial end and webhook processing.
    if (!subscription) {
      const expiredTrial = await prisma.userSubscription.findFirst({
        where: {
          userId,
          trialPlanId: { not: null },
          razorpayOrderId: { not: null },
          status: { in: ["ACTIVE", "TRIAL"] },
          endsAt: { lte: new Date() } // Trial has expired
        },
        orderBy: { startsAt: "desc" },
        include: { plan: true, trialPlan: true }
      });

      if (expiredTrial && expiredTrial.razorpayOrderId) {
        // Sync with Razorpay to check if the subscription has renewed
        try {
          const { getRazorpay } = await import("../../lib/razorpay");
          const razorpay = getRazorpay();
          const rpSub = await razorpay.subscriptions.fetch(expiredTrial.razorpayOrderId);

          if (rpSub.status === 'active' && rpSub.current_end) {
            // Razorpay says subscription is active! Update our DB
            const updatedSub = await prisma.userSubscription.update({
              where: { id: expiredTrial.id },
              data: {
                status: "ACTIVE",
                trialPlanId: null, // Trial is over
                startsAt: rpSub.current_start ? new Date(rpSub.current_start * 1000) : expiredTrial.startsAt,
                endsAt: new Date(rpSub.current_end * 1000)
              },
              include: { plan: true, trialPlan: true }
            });

            request.log.info({
              msg: "Synced expired trial with Razorpay - subscription is now active",
              subId: expiredTrial.id,
              razorpayStatus: rpSub.status
            });

            subscription = updatedSub;
          }
        } catch (err) {
          request.log.error(err, "Failed to sync with Razorpay for expired trial");
        }
      }
    }


    // Heal existing trial subscriptions created before the endsAt bug was fixed.
    // Bug: Razorpay's current_end (first billing period end, e.g. 30 days) was stored
    // instead of createdAt + trialPlan.durationDays (e.g. 7 days).
    // Bug was also in startsAt: stored as Razorpay's current_start (future billing start date)
    // instead of the actual trial start (createdAt).
    if (
      subscription &&
      (subscription.status === "TRIAL" || subscription.status === "CANCELED") &&
      subscription.trialPlanId &&
      subscription.trialPlan
    ) {
      // Use createdAt as the true trial start — it's always set to now() at insert time.
      const correctEndsAt = new Date(subscription.createdAt.getTime() + subscription.trialPlan.durationDays * 24 * 60 * 60 * 1000);
      const oneHour = 60 * 60 * 1000;
      if (subscription.endsAt.getTime() > correctEndsAt.getTime() + oneHour) {
        request.log.warn({
          msg: "Healing incorrect trial endsAt for existing subscription",
          subId: subscription.id,
          userId,
          wrongEndsAt: subscription.endsAt,
          correctEndsAt,
        });
        subscription = await prisma.userSubscription.update({
          where: { id: subscription.id },
          data: {
            startsAt: subscription.createdAt,  // was set to future billing start
            endsAt: correctEndsAt,
          },
          include: { plan: true, trialPlan: true },
        });
      }
    }

    // If user has a trial, return trial details instead of main plan
    const isTrial = subscription?.status === "TRIAL" || !!subscription?.trialPlanId;

    // Derive plan name from actual subscription duration (startsAt → endsAt)
    // so renaming a plan in DB doesn't show wrong name to existing subscribers.
    function derivePlanName(sub: typeof subscription): string | null {
      if (!sub) return null;
      const basePlan = sub.trialPlan || sub.plan;
      if (!basePlan) return null;
      const durationMs = sub.endsAt.getTime() - sub.startsAt.getTime();
      const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));
      const months = Math.round(durationDays / 30);
      if (months <= 1) return '1 Month Plan';
      return `${months} Month Plan`;
    }

    const data = subscription ? {
      ...subscription,
      isTrial,
      planCancelled: subscription.status === "CANCELED",
      showTrialBanner: !((subscription.plan as any)?.subscriptionViaTrial ?? false),
      // During trial period, show trial plan information
      displayPlan: subscription.trialPlan || subscription.plan,
      planDisplayName: derivePlanName(subscription),
    } : null;

    return {
      success: true,
      statusCode: 200,
      userMessage: "Subscription retrieved successfully",
      developerMessage: "User subscription details retrieved",
      hasUsedTrial: false,
      data,
    };
  });

  app.get("/me/transactions", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    const data = await prisma.transaction.findMany({
      where: { userId, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    // Ensure response includes subscriptionId and clear razorpayOrderId if it was misused before (though now we split them)
    // Since we added a new column, old data might still have sub_ in razorpayOrderId.
    // For new data, razorpayOrderId will be null for subscriptions.
    const formattedData = data.map(t => ({
      ...t,
      // If we have a subscriptionId in DB, use it. 
      // Fallback: If razorpayPlanId has legacy data (starts with sub_), use it
      subscriptionId: t.subscriptionId || (t.razorpayPlanId?.startsWith("sub_") ? t.razorpayPlanId : null),
      razorpayPlanId: t.razorpayPlanId,
      // razorpayOrderId is no longer available on Transaction
    }));
    return {
      success: true,
      statusCode: 200,
      userMessage: "Transactions retrieved successfully",
      developerMessage: "User transactions retrieved",
      data: formattedData,
    };
  });

  app.post("/purchase/intent", {
    schema: { body: purchaseIntentSchema },
  }, async (request, reply) => {
    const { planId, deviceId, isTrial, provider = "razorpay" } = request.body as z.infer<typeof purchaseIntentSchema>;
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.code(401).send({
        success: false,
        statusCode: 401,
        code: "UNAUTHORIZED",
        userMessage: "User not authenticated",
        developerMessage: "Missing x-user-id header"
      });
    }

    // Distributed lock — prevents two simultaneous intent calls creating duplicate mandates
    const redis = getRedis();
    const lockKey = `sub:intent:${userId}`;
    const lockAcquired = await redis.set(lockKey, "1", "EX", 30, "NX");
    if (!lockAcquired) {
      return reply.code(409).send({
        success: false,
        statusCode: 409,
        code: "SUBSCRIPTION_IN_PROGRESS",
        userMessage: "A subscription attempt is already in progress. Please wait.",
        developerMessage: "Redis lock active for userId"
      });
    }

    try {

    // Block if user already has an active, trial, or canceled-but-not-expired subscription
    // Exception: Trial users CAN upgrade to a full paid subscription
    const activeSubscription = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIAL", "CANCELED", "PAUSED"] },
        endsAt: { gt: new Date() },
      },
    });

    if (activeSubscription) {
      // A subscription is considered a trial if it's currently TRIAL, or if it's CANCELED but has a trialPlanId
      const isOriginallyTrial = activeSubscription.status === "TRIAL" || (activeSubscription.status === "CANCELED" && activeSubscription.trialPlanId !== null);

      // Allow trial → full paid upgrade (but NOT trial → trial)
      const isTrialUpgrade = isOriginallyTrial && !isTrial;

      if (!isTrialUpgrade) {
        const isCanceled = activeSubscription.status === "CANCELED";
        const endsAtFormatted = activeSubscription.endsAt.toLocaleDateString("en-IN", {
          day: "numeric", month: "short", year: "numeric"
        });

        return reply.code(409).send({
          success: false,
          statusCode: 409,
          code: "ALREADY_SUBSCRIBED",
          userMessage: isCanceled
            ? `Your current plan is active until ${endsAtFormatted}. You can purchase a new plan after it expires.`
            : "You already have an active subscription",
          developerMessage: isCanceled
            ? `User has a canceled subscription still valid until ${activeSubscription.endsAt.toISOString()}`
            : "User already has an active or trial subscription",
        });
      }
    }

    let plan = await prisma.subscriptionPlan.findFirst({
      where: { id: planId, deletedAt: null }
    });
    let trialPlan: any = null;

    if (plan && isTrial) {
      // User explicitly requested a trial for this plan.
      // Fetch the universal active trial plan
      trialPlan = await prisma.trialPlan.findFirst({
        where: { isActive: true }
      });

      if (!trialPlan) {
        return reply.badRequest("No active trial available");
      }
    }

    if (trialPlan) {
      if (!trialPlan.isActive) return reply.notFound("Trial plan is inactive");
    }

    if (!plan || !plan.isActive) {
      return reply.notFound("Plan not found or inactive");
    }

    // ─── PhonePe branch ───────────────────────────────────────────────────────
    if (provider === "phonepe") {
      const MANDATE_MAX_AMOUNT = 100000; // ₹1,000 ceiling
      const chargeAmountCheck = trialPlan ? trialPlan.trialPricePaise : plan.pricePaise;
      // Validate both current charge AND max future renewal amount against mandate ceiling
      if (chargeAmountCheck > MANDATE_MAX_AMOUNT || plan.pricePaise > MANDATE_MAX_AMOUNT) {
        return reply.badRequest("Plan price exceeds the maximum mandate amount allowed.");
      }

      // Mark stale pending PhonePe transactions as FAILED — no external cancel needed (no mandate yet)
      await prisma.transaction.updateMany({
        where: { userId, status: "PENDING", planId: plan.id, provider: "phonepe" },
        data: { status: "FAILED", failureReason: "Superseded by new purchase intent" },
      });

      const merchantSubscriptionId = `OMGTV_SUB_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const merchantOrderId = `OMGTV_ORD_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const chargeAmount = trialPlan ? trialPlan.trialPricePaise : plan.pricePaise;

      try {
        const phonepe = getPhonePe();
        const orderToken = await phonepe.createSubscriptionOrderToken({
          userId,
          merchantSubscriptionId,
          merchantOrderId,
          amount: chargeAmount,
          maxAmount: MANDATE_MAX_AMOUNT,
          planId: plan.id,
          isTrial: !!trialPlan,
        });

        const transaction = await prisma.transaction.create({
          data: {
            userId,
            planId: plan.id,
            amountPaise: chargeAmount,
            currency: plan.currency,
            status: "PENDING",
            provider: "phonepe",
            subscriptionId: merchantSubscriptionId,
            trialPlanId: trialPlan ? trialPlan.id : null,
            metadata: { deviceId, merchantOrderId, merchantSubscriptionId },
          },
        });

        void trackSubscriptionEvent(userId, "phonepe_purchase_started", {
          provider: "phonepe",
          plan_id: plan.id,
          is_trial: !!trialPlan,
          amount_rupees: chargeAmount / 100,
        });

        return reply.code(201).send({
          success: true,
          statusCode: 201,
          userMessage: "Purchase intent created successfully",
          developerMessage: "PhonePe order token created",
          data: {
            transactionId: transaction.id,
            provider: "phonepe",
            orderToken: orderToken.token,
            phonePeOrderId: orderToken.orderId,
            phonePeMerchantId: loadConfig().PHONEPE_MERCHANT_ID,
            merchantOrderId,
            merchantSubscriptionId,
            amountPaise: chargeAmount,
            currency: plan.currency,
          },
        });
      } catch (error: any) {
        request.log.error(error, "PhonePe createSubscriptionOrderToken failed");
        return reply.internalServerError("Failed to create subscription with payment provider");
      }
    }

    // ─── Razorpay branch (zero changes to existing logic) ────────────────────
    if (!plan.razorpayPlanId) {
      return reply.badRequest("Plan is not configured for online payments (missing Razorpay Plan ID)");
    }

    const { getRazorpay } = await import("../../lib/razorpay");
    const razorpay = getRazorpay();

    // Cancel any abandoned PENDING transactions for this user to prevent ghost Razorpay subscriptions
    const stalePendingTxs = await prisma.transaction.findMany({
      where: { userId, status: "PENDING", planId: plan.id, provider: "razorpay" },
    });

    for (const staleTx of stalePendingTxs) {
      await prisma.transaction.update({
        where: { id: staleTx.id },
        data: { status: "FAILED", failureReason: "Superseded by new purchase intent" },
      });
      if (staleTx.subscriptionId) {
        try {
          await razorpay.subscriptions.cancel(staleTx.subscriptionId);
          request.log.info({ msg: "Cancelled stale Razorpay subscription", subscriptionId: staleTx.subscriptionId });
        } catch (cancelErr: any) {
          request.log.warn(cancelErr, "Failed to cancel stale Razorpay subscription (may already be cancelled)");
        }
      }
    }

    try {
      const subscriptionOptions: any = {
        plan_id: plan.razorpayPlanId,
        customer_notify: 1,
        total_count: 120, // Default to 10 years (120 months) for auto-renew
        quantity: 1,
        notes: {
          userId,
          planId: trialPlan ? trialPlan.id : plan.id,
          internalPlanId: plan.id,
          isTrial: !!trialPlan
        }
      };

      if (trialPlan) {
        const startAt = Math.floor(Date.now() / 1000) + (trialPlan.durationDays * 24 * 60 * 60);
        subscriptionOptions.start_at = startAt;
        if (trialPlan.trialPricePaise > 0) {
          subscriptionOptions.addons = [{
            item: {
              name: "Trial Period Charge",
              amount: trialPlan.trialPricePaise,
              currency: plan.currency
            }
          }];
        }
      }

      const subscription = await razorpay.subscriptions.create(subscriptionOptions);

      const transaction = await prisma.transaction.create({
        data: {
          userId,
          planId: plan.id,
          amountPaise: trialPlan ? trialPlan.trialPricePaise : plan.pricePaise,
          currency: plan.currency,
          subscriptionId: subscription.id,
          razorpayPlanId: plan.razorpayPlanId,
          trialPlanId: trialPlan ? trialPlan.id : null,
          provider: "razorpay",
          metadata: {
            deviceId,
            subscriptionId: subscription.id,
            trialPlanId: trialPlan?.id
          },
        },
      });

      return reply.code(201).send({
        success: true,
        statusCode: 201,
        userMessage: "Purchase intent created successfully",
        developerMessage: "Razorpay subscription created",
        data: {
          transactionId: transaction.id,
          subscriptionId: subscription.id,
          amountPaise: transaction.amountPaise,
          currency: transaction.currency,
          razorpayKeyId: process.env.RAZORPAY_KEY_ID
        }
      });
    } catch (error: any) {
      request.log.error(error);
      return reply.internalServerError("Failed to create subscription with payment provider");
    }
    } finally {
      await redis.del(lockKey);
    }
  });

  const verifyPurchaseSchema = z.object({
    // Razorpay fields
    paymentId: z.string().optional(),
    subscriptionId: z.string().optional(),
    signature: z.string().optional(),
    // PhonePe fields
    merchantOrderId: z.string().optional(),
    merchantSubscriptionId: z.string().optional(),
    transactionId: z.string().optional(),
    // Router — defaults to razorpay so existing mobile callers need no change
    provider: z.enum(["razorpay", "phonepe"]).default("razorpay").optional(),
  });

  app.post("/purchase/verify", {
    schema: { body: verifyPurchaseSchema },
  }, async (request, reply) => {
    const body = request.body as z.infer<typeof verifyPurchaseSchema>;
    const { provider = "razorpay" } = body;
    const userId = request.headers["x-user-id"] as string;

    // ─── PhonePe verify branch ────────────────────────────────────────────────
    if (provider === "phonepe") {
      const MANDATE_MAX_AMOUNT = 100000; // ₹1,000 — must match what was sent at mandate setup
      const { merchantOrderId, merchantSubscriptionId, transactionId } = body;

      if (!merchantOrderId || !merchantSubscriptionId || !transactionId) {
        return reply.badRequest("merchantOrderId, merchantSubscriptionId and transactionId are required for PhonePe verify");
      }

      const transaction = await prisma.transaction.findFirst({
        where: { id: transactionId, provider: "phonepe", userId },
      });
      if (!transaction) return reply.notFound("Transaction not found");

      // Idempotency check 1: transaction already processed (mobile retry of same request)
      // Also handles webhook-first scenario: webhook marked transaction SUCCESS but subscription not yet created
      if (transaction.status === "SUCCESS") {
        const alreadyCreated = await prisma.userSubscription.findFirst({
          where: { transactionId: transaction.id, provider: "phonepe" },
        });
        if (alreadyCreated) {
          return reply.send({ success: true, statusCode: 200, userMessage: "Payment verified successfully", data: { status: "active" } });
        }
        // Transaction is SUCCESS (set by webhook) but subscription not created yet — continue to create it
      }

      // Step 1: Verify the setup ORDER (penny drop) completed — this is the payment confirmation.
      // The subscription mandate may still be ACTIVATION_IN_PROGRESS at this point (async on PhonePe's side).
      let orderStatus: any;
      try {
        orderStatus = await getPhonePe().getRedemptionStatus(merchantOrderId!, userId);
      } catch (err: any) {
        request.log.error({ err, merchantOrderId }, "PhonePe getOrderStatus failed");
        // If the transaction was already marked SUCCESS by webhook, proceed without order check
        if (transaction.status !== "SUCCESS") {
          return reply.internalServerError("Could not verify payment status with PhonePe");
        }
      }

      if (orderStatus) {
        if (orderStatus.state === "FAILED") {
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: { status: "FAILED", failureReason: orderStatus.errorCode ?? "Setup order failed" },
          });
          void trackSubscriptionEvent(userId, "phonepe_payment_failed", {
            provider: "phonepe",
            plan_id: transaction.planId ?? "",
            is_trial: !!transaction.trialPlanId,
            error_code: orderStatus.errorCode,
            stage: "setup_order",
          });
          return reply.code(400).send({
            success: false, statusCode: 400, code: "PAYMENT_FAILED",
            userMessage: "Payment failed. Please try again.",
            developerMessage: `PhonePe order state: FAILED, errorCode: ${orderStatus.errorCode}`,
          });
        }
        if (orderStatus.state === "PENDING") {
          return reply.code(400).send({
            success: false, statusCode: 400, code: "PAYMENT_PENDING",
            userMessage: "Payment is still being processed. Please wait a moment and try again.",
            developerMessage: "PhonePe order state: PENDING",
          });
        }
        // orderStatus.state === "COMPLETED" → payment confirmed, continue
      }

      // Step 2: Fetch subscription status best-effort (to get PhonePe's internal subscription ID).
      // Mandate may be ACTIVATION_IN_PROGRESS — that's fine, payment is already confirmed by the order.
      let ppStatus: any;
      let phonePeSubscriptionId = merchantSubscriptionId;
      try {
        ppStatus = await getPhonePe().getSubscriptionStatus(merchantSubscriptionId, userId);
        phonePeSubscriptionId = ppStatus.subscriptionId ?? merchantSubscriptionId;
        if (ppStatus.state === "FAILED" || ppStatus.state === "CANCELLED") {
          return reply.code(400).send({
            success: false, statusCode: 400, code: "MANDATE_FAILED",
            userMessage: "Subscription mandate failed. Please try again.",
            developerMessage: `PhonePe subscription state: ${ppStatus.state}`,
          });
        }
      } catch (err: any) {
        // Subscription status check is best-effort — the order confirmation above is authoritative.
        request.log.warn({ err, merchantSubscriptionId }, "PhonePe getSubscriptionStatus failed — proceeding on order confirmation");
      }

      // Idempotency check 2: another device raced and already created the subscription
      const existingSub = await prisma.userSubscription.findFirst({
        where: { userId: transaction.userId, provider: "phonepe", status: { in: ["ACTIVE", "TRIAL", "PAUSED"] } },
      });
      if (existingSub) {
        // Cancel the losing mandate (different merchantSubscriptionId means a different device won)
        if (existingSub.phonePeSubscriptionId !== merchantSubscriptionId) {
          try { await getPhonePe().cancelSubscription(merchantSubscriptionId, userId) } catch {}
        }
        return reply.send({ success: true, statusCode: 200, userMessage: "Payment verified successfully", data: { status: "active" } });
      }

      // Expire existing trial if this is an upgrade
      const existingTrialSub = await prisma.userSubscription.findFirst({
        where: { userId: transaction.userId, status: { in: ["TRIAL", "CANCELED"] }, trialPlanId: { not: null }, endsAt: { gt: new Date() } },
      });
      if (existingTrialSub) {
        await prisma.userSubscription.update({ where: { id: existingTrialSub.id }, data: { status: "EXPIRED", endsAt: new Date() } });
        if (existingTrialSub.phonePeSubscriptionId) {
          try { await getPhonePe().cancelSubscription(existingTrialSub.phonePeSubscriptionId, userId) } catch {}
        }
        // Cancel pending redemptions for old trial
        await prisma.phonePeRedemption.updateMany({
          where: { userSubscriptionId: existingTrialSub.id, status: { in: ["PENDING_NOTIFY", "NOTIFIED"] } },
          data: { status: "FAILED", lastError: "Superseded by plan upgrade" },
        });
      }

      await prisma.transaction.update({ where: { id: transaction.id }, data: { status: "SUCCESS" } });

      const trialPlanId = transaction.trialPlanId;
      let startsAt = new Date();
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
            userId: transaction.userId,
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
          // Concurrent verify call won the race — subscription already created, return success
          await invalidateEntitlementCache(transaction.userId);
          return reply.send({ success: true, statusCode: 200, userMessage: "Payment verified successfully", data: { status: "active" } });
        }
        throw err;
      }

      // First payment already done by SDK — mark cycle 1 SUCCESS
      // try/catch: concurrent verify calls would hit unique constraint on merchantOrderId
      try { await prisma.phonePeRedemption.create({
        data: {
          userId: transaction.userId,
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
      }); } catch { /* duplicate merchantOrderId — concurrent verify, safe to ignore */ }

      // Schedule cycle 2 (first auto-renewal)
      const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
      if (plan) {
        const scheduledNotifyAt = new Date(endsAt.getTime() - 49 * 60 * 60 * 1000);
        try {
          await prisma.phonePeRedemption.create({
            data: {
              userId: transaction.userId,
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
            request.log.error({ msg: "phonepe_verify: failed to create cycle 2 redemption — manual check needed", userId: transaction.userId, error: err?.message });
          }
        }
      }

      await invalidateEntitlementCache(transaction.userId);
      const isTrial = !!trialPlanId;

      if (isTrial) {
        const trialDays = Math.round((endsAt.getTime() - startsAt.getTime()) / (1000 * 86400));
        void trackSubscriptionEvent(transaction.userId, "trial_activated", { plan_id: transaction.planId ?? "", trial_days: trialDays, provider: "phonepe" });
        const priorTrials = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: { not: null }, id: { not: newSub.id } } });
        if (priorTrials === 0) void trackSubscriptionEvent(transaction.userId, "first_trial_purchased", { plan_id: transaction.planId ?? "", trial_days: trialDays, provider: "phonepe" });
        await notificationClient.sendPush(transaction.userId, "Free Trial Activated!", `Your ${trialDays} day trial has been activated.`, { type: "SUBSCRIPTION_ACTIVATED" });
      } else {
        void trackSubscriptionEvent(transaction.userId, "subscription_activated", { plan_id: transaction.planId ?? "", provider: "phonepe" });
        const priorPaidSubs = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: null, id: { not: newSub.id } } });
        if (priorPaidSubs === 0) void trackSubscriptionEvent(transaction.userId, "first_subscription_purchased", { plan_id: transaction.planId ?? "", provider: "phonepe" });
        await notificationClient.sendPush(transaction.userId, "Subscription Activated", "Your subscription is now active. Enjoy unlimited content!", { type: "SUBSCRIPTION_ACTIVATED" });
      }

      return reply.send({ success: true, statusCode: 200, userMessage: "Payment verified successfully", data: { status: "active" } });
    }

    // ─── Razorpay verify branch (zero changes) ────────────────────────────────
    const { paymentId, subscriptionId, signature } = body;
    if (!paymentId || !subscriptionId || !signature) {
      return reply.badRequest("paymentId, subscriptionId and signature are required for Razorpay verify");
    }
    const { getRazorpay } = await import("../../lib/razorpay");

    // Validate signature
    const razorpayConfig = await import("../../config").then(m => m.loadConfig());

    const expectedSignature = crypto
      .createHmac("sha256", razorpayConfig.RAZORPAY_KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest("hex");

    if (expectedSignature !== signature) {
      return reply.badRequest("Invalid signature");
    }

    // Find transaction and update
    // Check by subscriptionId first (new flow), then fallback to razorpayOrderId (old flow)
    const transaction = await prisma.transaction.findFirst({
      where: {
        OR: [
          { subscriptionId }
        ],
        status: "PENDING"
      }
    });

    if (!transaction) {
      // Check if already success?
      const existing = await prisma.transaction.findFirst({
        where: {
          OR: [
            { subscriptionId }
          ],
          status: "SUCCESS"
        }
      });
      if (existing) {
        return reply.send({ success: true, message: "Already verified" });
      }
      return reply.notFound("Transaction not found");
    }

    // Update Transaction
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: "SUCCESS",
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      }
    });

    const razorpay = getRazorpay();
    let startsAt = new Date();
    let endsAt = new Date();

    // Extract trialPlanId from metadata or transaction
    const metadata = transaction.metadata as Record<string, any> | null;
    const trialPlanId = transaction.trialPlanId || metadata?.trialPlanId;

    if (trialPlanId) {
      // Razorpay's current_start/current_end reflect the first BILLING period (after the trial
      // ends), not the trial window. Derive the trial end date from the admin-configured
      // trialPlan.durationDays so the subscription expires at the correct time.
      const trialPlan = await prisma.trialPlan.findUnique({ where: { id: trialPlanId } });
      if (trialPlan) {
        startsAt = new Date();
        endsAt = new Date(Date.now() + trialPlan.durationDays * 24 * 60 * 60 * 1000);
      }
    } else {
      try {
        const sub = await razorpay.subscriptions.fetch(subscriptionId);
        if (sub.current_start && sub.current_end) {
          startsAt = new Date(sub.current_start * 1000);
          endsAt = new Date(sub.current_end * 1000);
        } else {
          const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
          if (plan) {
            endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
          }
        }
      } catch (e) {
        request.log.error(e, "Failed to fetch subscription details");
        const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
        if (plan) {
          endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
        }
      }
    }

    // If user is upgrading from trial, expire the old trial subscription
    const existingTrialSub = await prisma.userSubscription.findFirst({
      where: {
        userId: transaction.userId,
        status: { in: ["TRIAL", "CANCELED"] },
        trialPlanId: { not: null },
        endsAt: { gt: new Date() },
      },
    });

    if (existingTrialSub) {
      await prisma.userSubscription.update({
        where: { id: existingTrialSub.id },
        data: { status: "EXPIRED", endsAt: new Date() },
      });

      // Cancel the old trial's Razorpay subscription to stop future charges
      if (existingTrialSub.razorpayOrderId) {
        try {
          await razorpay.subscriptions.cancel(existingTrialSub.razorpayOrderId);
          request.log.info({
            msg: "Cancelled old trial Razorpay subscription during upgrade",
            oldSubId: existingTrialSub.id,
            razorpaySubId: existingTrialSub.razorpayOrderId,
          });
        } catch (cancelErr) {
          request.log.warn(cancelErr, "Failed to cancel old trial on Razorpay (may already be cancelled)");
        }
      }
    }

    const newSub = await prisma.userSubscription.create({
      data: {
        userId: transaction.userId,
        planId: transaction.planId,
        trialPlanId: trialPlanId,
        status: trialPlanId ? "TRIAL" : "ACTIVE",
        razorpayOrderId: subscriptionId,
        transactionId: transaction.id,
        provider: "razorpay",
        startsAt,
        endsAt
      }
    });

    await invalidateEntitlementCache(transaction.userId);

    const isTrial = !!trialPlanId;

    if (isTrial) {
      const trialDays = Math.round((endsAt.getTime() - startsAt.getTime()) / (1000 * 86400));
      void trackSubscriptionEvent(transaction.userId, 'trial_activated', { plan_id: transaction.planId ?? '', trial_days: trialDays });
      const priorTrials = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: { not: null }, id: { not: newSub.id } } });
      if (priorTrials === 0) void trackSubscriptionEvent(transaction.userId, 'first_trial_purchased', { plan_id: transaction.planId ?? '', trial_days: trialDays });
    } else {
      void trackSubscriptionEvent(transaction.userId, 'subscription_activated', { plan_id: transaction.planId ?? '' });
      const priorPaidSubs = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: null, id: { not: newSub.id } } });
      if (priorPaidSubs === 0) void trackSubscriptionEvent(transaction.userId, 'first_subscription_purchased', { plan_id: transaction.planId ?? '' });
    }
    if (!(await notificationClient.hasSentRecently(transaction.userId, "SUBSCRIPTION_ACTIVATED"))) {
      if (isTrial) {
        const trialDays = Math.round((endsAt.getTime() - startsAt.getTime()) / (1000 * 86400));
        await notificationClient.sendPush(
          transaction.userId,
          "Free Trial Activated!",
          `Your ${trialDays} day trial has been activated. Enjoy watching the episodes!`,
          { type: "SUBSCRIPTION_ACTIVATED" }
        );
      } else {
        await notificationClient.sendPush(
          transaction.userId,
          "Subscription Activated",
          "Your subscription is now active. Enjoy unlimited content!",
          { type: "SUBSCRIPTION_ACTIVATED" }
        );
      }
    }

    return reply.send({
      success: true,
      statusCode: 200,
      userMessage: "Payment verified successfully",
      developerMessage: "Payment verified and subscription activated",
      data: { status: "active" }
    });
  });

  // ─── Cancel subscription ────────────────────────────────────────────────────
  app.post("/me/cancel", async (request, reply) => {
    const userId = request.headers["x-user-id"] as string;

    const sub = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIAL"] },
        endsAt: { gt: new Date() },
      },
      orderBy: { startsAt: "desc" },
    });

    if (!sub) {
      return reply.code(404).send({
        success: false,
        statusCode: 404,
        code: "NO_ACTIVE_SUBSCRIPTION",
        userMessage: "You don't have an active subscription to cancel.",
      });
    }

    // Mark CANCELED — user retains access until endsAt (end of billing period)
    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { status: "CANCELED" },
    });

    await invalidateEntitlementCache(userId);

    const isTrial = !!sub.trialPlanId;

    // ── Provider-side cancellation (best-effort — DB is already CANCELED) ──────
    if (sub.provider === "razorpay" && sub.razorpayOrderId) {
      try {
        const { getRazorpay } = await import("../../lib/razorpay");
        await getRazorpay().subscriptions.cancel(sub.razorpayOrderId);
        request.log.info({ msg: "Razorpay subscription cancelled", subId: sub.id, razorpayOrderId: sub.razorpayOrderId });
      } catch (err: any) {
        // Webhook will arrive regardless — DB is already CANCELED, so this is safe to swallow
        request.log.warn({ err, subId: sub.id }, "Failed to cancel Razorpay subscription (webhook will reconcile)");
      }
    }

    if (sub.provider === "phonepe" && sub.phonePeSubscriptionId) {
      // Cancel pending redemptions so billing cron doesn't charge after cancellation
      try {
        await prisma.phonePeRedemption.updateMany({
          where: {
            userSubscriptionId: sub.id,
            status: { in: ["PENDING_NOTIFY", "NOTIFIED"] },
          },
          data: { status: "FAILED", lastError: "Cancelled by user" },
        });
      } catch (err: any) {
        request.log.warn({ err, subId: sub.id }, "Failed to cancel PhonePe pending redemptions — billing cron will skip CANCELED sub");
      }

      try {
        await getPhonePe().cancelSubscription(sub.phonePeSubscriptionId, userId);
        request.log.info({ msg: "PhonePe mandate cancelled", subId: sub.id, phonePeSubscriptionId: sub.phonePeSubscriptionId });
      } catch (err: any) {
        request.log.warn({ err, subId: sub.id }, "Failed to cancel PhonePe mandate (webhook will reconcile)");
      }
    }

    // Fire analytics here (user intent). Razorpay/PhonePe webhooks will also fire
    // subscription_cancelled with reason="cancelled"/"user_revoked" — that's the provider
    // confirmation. Both are useful signals; dedup in dashboard by filtering reason="user_requested".
    const daysActive = Math.floor((Date.now() - sub.startsAt.getTime()) / (1000 * 86400));
    void trackSubscriptionEvent(userId, isTrial ? "trial_cancelled" : "subscription_cancelled", {
      provider: sub.provider,
      plan_id: sub.planId ?? "",
      days_active: daysActive,
      reason: "user_requested",
    });

    const endsAtFormatted = sub.endsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

    return reply.send({
      success: true,
      statusCode: 200,
      userMessage: isTrial
        ? `Your trial has been cancelled. You'll retain access until ${endsAtFormatted}.`
        : `Your subscription has been cancelled. You'll retain access until ${endsAtFormatted}.`,
      data: { status: "canceled", endsAt: sub.endsAt },
    });
  });

  // --- Coin Routes ---

  // GET Ad-coin config for mobile (controls whether to show Watch Ad tab)
  app.get("/coins/ad-config", async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }

    const adConfig = await coinService.getAdCoinConfig();

    if (!adConfig.isEnabled) {
      return {
        isEnabled: false,
        coinsPerAd: adConfig.coinsPerAd,
        dailyLimit: adConfig.dailyLimit,
        watchedToday: 0,
        remainingToday: 0,
        expiryHours: adConfig.expiryHours,
      };
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const watchedToday = await prisma.coinTransaction.count({
      where: {
        userId,
        type: CoinTransactionType.CREDIT,
        source: TransactionSource.AD,
        createdAt: { gte: since },
      },
    });

    return {
      isEnabled: true,
      coinsPerAd: adConfig.coinsPerAd,
      dailyLimit: adConfig.dailyLimit,
      watchedToday,
      remainingToday: Math.max(0, adConfig.dailyLimit - watchedToday),
      expiryHours: adConfig.expiryHours,
    };
  });

  // POST Earn coins by watching an ad
  app.post("/coins/earn", {
    schema: {
      body: z.object({
        adId: z.string().min(1),
      }),
    },
  }, async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }

    const adConfig = await coinService.getAdCoinConfig();

    if (!adConfig.isEnabled) {
      return reply.code(403).send({ error: "Ad coin rewards are currently disabled" });
    }

    // Daily frequency check
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const watchedToday = await prisma.coinTransaction.count({
      where: {
        userId,
        type: CoinTransactionType.CREDIT,
        source: TransactionSource.AD,
        createdAt: { gte: since },
      },
    });

    if (watchedToday >= adConfig.dailyLimit) {
      const balance = await coinService.getBalance(userId);
      return {
        success: true,
        limitReached: true,
        coinsEarned: 0,
        remainingToday: 0,
        balance,
      };
    }

    const { adId } = request.body as { adId: string };
    const referenceId = `ad_reward:${adId}`;

    // Idempotency — same adId can only be claimed once
    const existing = await prisma.coinTransaction.findUnique({
      where: { referenceId },
    });

    if (existing) {
      const balance = await coinService.getBalance(userId);
      return {
        success: true,
        alreadyClaimed: true,
        coinsEarned: 0,
        remainingToday: Math.max(0, adConfig.dailyLimit - watchedToday),
        balance,
      };
    }

    await coinService.creditCoins({
      userId,
      amount: adConfig.coinsPerAd,
      source: TransactionSource.AD,
      referenceId,
      expiryDays: adConfig.expiryHours != null
        ? adConfig.expiryHours / 24
        : undefined,
    });

    const balance = await coinService.getBalance(userId);
    return {
      success: true,
      limitReached: false,
      alreadyClaimed: false,
      coinsEarned: adConfig.coinsPerAd,
      remainingToday: Math.max(0, adConfig.dailyLimit - watchedToday - 1),
      balance,
    };
  });

  // GET User balance
  app.get("/coins/balance", async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }
    const [balance, adStats, streakStats] = await Promise.all([
      coinService.getBalance(userId),
      coinService.getAdCoinStats(userId),
      coinService.getStreakCoinStats(userId),
    ]);
    return {
      balance,
      adCoinsBalance: adStats.adCoinsBalance,
      adCoinsExpiryAt: adStats.nearestExpiryAt,
      streakCoinsBalance: streakStats.streakCoinsBalance,
      streakCoinsExpiryAt: streakStats.nearestExpiryAt,
    };
  });

  // GET Unified Transaction History (coin_buy + coin_spend)
  app.get("/coins/transactions", {
    schema: {
      querystring: z.object({
        type: z.enum(["coin_buy", "coin_spend", "earned", "expired", "streak", "streak_bonus"]).optional(),
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(50).default(20),
      })
    }
  }, async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }

    const { type, page, limit } = request.query as { type?: "coin_buy" | "coin_spend" | "earned" | "expired" | "streak" | "streak_bonus"; page: number; limit: number };
    const skip = (page - 1) * limit;

    const typeWhere = type === "coin_buy"
      ? { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE }
      : type === "coin_spend"
        ? { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK }
        : type === "earned"
          ? { type: CoinTransactionType.CREDIT, source: TransactionSource.AD }
          : type === "expired"
            ? { type: CoinTransactionType.DEBIT, source: TransactionSource.EXPIRY }
            : type === "streak"
              ? { type: CoinTransactionType.CREDIT, source: TransactionSource.STREAK }
              : type === "streak_bonus"
                ? { type: CoinTransactionType.CREDIT, source: TransactionSource.STREAK_BONUS }
                : {}; // no filter → all transactions

    const where = { userId, ...typeWhere };

    const [total, txs] = await Promise.all([
      prisma.coinTransaction.count({ where }),
      prisma.coinTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    // --- Enrich coin_buy ---
    const buyTxs = txs.filter(tx => tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE);
    const orderIds = buyTxs.map(tx => tx.referenceId).filter(Boolean) as string[];

    const [purchases, episodeDetails] = await Promise.all([
      orderIds.length
        ? prisma.userCoinPurchase.findMany({ where: { orderId: { in: orderIds } } })
        : Promise.resolve([]),
      // --- Enrich coin_spend ---
      (async () => {
        const spendTxs = txs.filter(tx => tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK);
        const episodeIds = spendTxs
          .map(tx => tx.referenceId?.split(":")?.[2])
          .filter(Boolean) as string[];
        return episodeIds.length ? contentClient.getEpisodesBatch(episodeIds) : [];
      })(),
    ]);

    const bundleIds = [...new Set(purchases.map(p => p.bundleId))];
    const bundles = bundleIds.length
      ? await prisma.coinBundle.findMany({ where: { id: { in: bundleIds } } })
      : [];

    const purchaseMap = new Map(purchases.map(p => [p.orderId, p]));
    const bundleMap = new Map(bundles.map(b => [b.id, b]));
    const episodeMap = new Map(episodeDetails.map((ep: any) => [ep.id, ep]));

    // --- Build enriched items ---
    const items = txs.map(tx => {
      const base = { id: tx.id, createdAt: tx.createdAt };

      if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE) {
        const purchase = purchaseMap.get(tx.referenceId ?? "");
        const bundle = purchase ? bundleMap.get(purchase.bundleId) : null;
        return {
          ...base,
          transactionType: "coin_buy" as const,
          coins: tx.amount,
          payment: purchase ? {
            orderId: purchase.orderId,
            paymentId: purchase.paymentId,
            amountPaid: purchase.amountPaid,
            currency: bundle?.currency ?? "INR",
            status: purchase.status,
          } : null,
          bundle: bundle ? {
            title: bundle.title,
            coins: bundle.coins,
            price: bundle.price,
            currency: bundle.currency,
          } : null,
        };
      }

      // earned (from ad)
      if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.AD) {
        return {
          ...base,
          transactionType: "earned" as const,
          coins: tx.amount,
        };
      }

      // streak daily coins
      if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.STREAK) {
        return {
          ...base,
          transactionType: "streak" as const,
          coins: tx.amount,
          expiresAt: tx.expiryAt ?? null,
        };
      }

      // streak milestone bonus
      if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.STREAK_BONUS) {
        return {
          ...base,
          transactionType: "streak_bonus" as const,
          coins: tx.amount,
          expiresAt: tx.expiryAt ?? null,
        };
      }

      // expired coins (ad/streak coins that hit their expiryAt)
      if (tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.EXPIRY) {
        const meta = tx.metadata as Record<string, any> | null;
        return {
          ...base,
          transactionType: "expired" as const,
          coinsExpired: Math.abs(tx.amount),
          expiredCreditId: meta?.expiredCreditId ?? null,
        };
      }

      // coin_spend (episode unlock)
      if (tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK) {
        const episodeId = tx.referenceId?.split(":")?.[2] ?? null;
        const ep = episodeId ? episodeMap.get(episodeId) : null;
        return {
          ...base,
          transactionType: "coin_spend" as const,
          coinsSpent: Math.abs(tx.amount),
          episode: ep
            ? { id: episodeId, title: ep.title, thumbnail: ep.thumbnail, seriesName: ep.seriesTitle }
            : { id: episodeId },
        };
      }

      // admin adjustments or any other DEBIT type
      return {
        ...base,
        transactionType: "other" as const,
        coins: tx.amount,
        source: tx.source,
      };
    });

    // --- Group by today / yesterday / other ---
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    const groupItem = (item: (typeof items)[0]) => {
      const d = new Date(item.createdAt);
      if (d >= todayStart) return "today";
      if (d >= yesterdayStart) return "yesterday";
      return "other";
    };

    const today: typeof items = [];
    const yesterday: typeof items = [];
    const other: typeof items = [];
    for (const item of items) {
      const g = groupItem(item);
      if (g === "today") today.push(item);
      else if (g === "yesterday") yesterday.push(item);
      else other.push(item);
    }

    return {
      success: true,
      today,
      yesterday,
      other,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  // GET Available Bundles
  app.get("/coins/bundles", async () => {
    const redis = getRedis();
    const cacheKey = "coins:bundles:all";

    // Try to get from cache
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      return JSON.parse(cached);
    }

    const bundles = await prisma.coinBundle.findMany({ where: { active: true } });

    // Cache for 10 minutes
    await redis.setex(cacheKey, 600, JSON.stringify(bundles)).catch(() => { });

    return bundles;
  });

  // POST Create Coin Purchase Order
  app.post(
    "/coins/purchase/create",
    {
      schema: {
        body: z.object({ bundleId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { bundleId } = request.body as { bundleId: string };

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      try {
        await coinService.checkWalletStatus(userId);

        const bundle = await prisma.coinBundle.findFirst({
          where: { id: bundleId, active: true },
        });

        if (!bundle) {
          return reply.code(404).send({ error: "Coin bundle not found" });
        }

        const amountPaise = bundle.price * 100;

        // Reuse or refresh existing pending order for this user+bundle
        const existingPurchase = await prisma.userCoinPurchase.findFirst({
          where: { userId, bundleId, status: "CREATED" },
        });

        const razorpay = getRazorpay();

        if (existingPurchase) {
          const ageMs = Date.now() - new Date(existingPurchase.createdAt).getTime();
          const isStale = ageMs > 30 * 60 * 1000; // older than 30 minutes

          if (!isStale) {
            // Fresh enough — return existing order
            return {
              success: true,
              orderId: existingPurchase.orderId,
              amountPaise,
              coins: bundle.coins,
              purchaseId: existingPurchase.id,
              razorpayKeyId: config.RAZORPAY_KEY_ID,
            };
          }

          // Stale — create new Razorpay order and update the same row
          const freshOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency: "INR",
            notes: { userId, bundleId, type: "COIN_PURCHASE" },
          });
          await prisma.userCoinPurchase.update({
            where: { id: existingPurchase.id },
            data: { orderId: freshOrder.id, createdAt: new Date() },
          });
          return {
            success: true,
            orderId: freshOrder.id,
            amountPaise,
            coins: bundle.coins,
            purchaseId: existingPurchase.id,
            razorpayKeyId: config.RAZORPAY_KEY_ID,
          };
        }

        const order = await razorpay.orders.create({
          amount: amountPaise,
          currency: "INR",
          notes: { userId, bundleId, type: "COIN_PURCHASE" },
        });

        const purchase = await prisma.userCoinPurchase.create({
          data: {
            userId,
            bundleId,
            amountPaid: amountPaise,
            coins: bundle.coins,
            orderId: order.id,
            status: "CREATED",
          },
        });

        return {
          success: true,
          orderId: order.id,
          amountPaise,
          coins: bundle.coins,
          purchaseId: purchase.id,
          razorpayKeyId: config.RAZORPAY_KEY_ID,
        };
      } catch (error: any) {
        if (error.message === "Wallet is blocked. Please contact support.") {
          return reply.code(403).send({ error: error.message });
        }
        request.log.error(error, "Failed to create Razorpay order for coins");
        return reply.code(500).send({
          error: "Failed to create purchase order",
          message: error.message,
          razorpayError: error.description || error.error?.description || "Unknown provider error",
        });
      }
    }
  );

  // POST Verify Coin Purchase
  app.post(
    "/coins/purchase/verify",
    {
      schema: {
        body: z.object({
          orderId: z.string(),
          paymentId: z.string(),
          signature: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { orderId, paymentId, signature } = request.body as { orderId: string; paymentId: string; signature: string };

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      // Verify Signature
      const expectedSignature = crypto
        .createHmac("sha256", config.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      if (expectedSignature !== signature) {
        return reply.code(400).send({ error: "Invalid payment signature" });
      }

      // Update Purchase Record
      const purchase = await prisma.userCoinPurchase.findUnique({
        where: { orderId }
      });

      if (!purchase || purchase.userId !== userId) {
        return reply.code(404).send({ error: "Purchase record not found" });
      }

      if (purchase.status === "SUCCESS") {
        return { success: true, message: "Already verified", balance: await coinService.getBalance(userId) };
      }

      // Pre-check for existing coin transaction with this orderId (idempotency guard)
      const existingTx = await prisma.coinTransaction.findUnique({
        where: { referenceId: orderId }
      });

      if (existingTx) {
        // If transaction exists but purchase record was not marked SUCCESS, sync it now
        await prisma.userCoinPurchase.update({
          where: { id: purchase.id },
          data: { status: "SUCCESS", paymentId }
        });
        return { success: true, message: "Already credited", balance: await coinService.getBalance(userId) };
      }

      await prisma.$transaction(async (tx) => {
        await tx.userCoinPurchase.update({
          where: { id: purchase.id },
          data: {
            status: "SUCCESS",
            paymentId,
            metadata: { signature }
          }
        });

        // Credit the coins — pass tx so both ops are in the same DB transaction
        await coinService.creditCoins({
          userId,
          amount: purchase.coins,
          source: TransactionSource.PURCHASE,
          referenceId: orderId,
        }, tx);
      });

      await notificationClient.sendPush(
        userId,
        "Coins Added!",
        `${purchase.coins} coins added! Use coins to unlock episodes.`,
        { type: "COIN_PURCHASE_SUCCESS", coins: String(purchase.coins) }
      );

      return { success: true, balance: await coinService.getBalance(userId) };
    }
  );

  // POST Unlock Episode
  app.post<{ Body: { episodeId: string; coinCost: number } }>(
    "/coins/unlock",
    {
      schema: {
        body: z.object({
          episodeId: z.string().uuid(),
          coinCost: z.number().int().positive(),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { episodeId, coinCost } = request.body;

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      try {
        const result = await coinService.unlockEpisode(userId, episodeId, coinCost);
        const newBalance = await coinService.getBalance(userId);
        const alreadyUnlocked = result.status === "ALREADY_UNLOCKED";
        return {
          status: result.status,
          episodeId,
          coinsSpent: alreadyUnlocked ? 0 : coinCost,
          newBalance,
          coinUnlockPurchased: true,
        };
      } catch (err: any) {
        if (err.message === "Insufficient coin balance") {
          return reply.code(402).send({ error: "Insufficient coin balance", required: coinCost });
        }
        throw err;
      }
    }
  );

  // GET Unlock History with episode details
  app.get(
    "/coins/unlocks",
    {
      schema: {
        querystring: z.object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(50).default(20),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      const { page, limit } = request.query as { page: number; limit: number };
      const skip = (page - 1) * limit;

      const [unlocks, total] = await Promise.all([
        prisma.userEpisodeUnlock.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip,
        }),
        prisma.userEpisodeUnlock.count({ where: { userId } }),
      ]);

      if (!unlocks.length) {
        return { success: true, data: [], pagination: { total: 0, page, limit, totalPages: 0 } };
      }

      // Fetch coins spent per episode from debit transactions
      const referenceIds = unlocks.map((u) => `unlock:${userId}:${u.episodeId}`);
      const [debitTxs, episodeDetails] = await Promise.all([
        prisma.coinTransaction.findMany({
          where: { referenceId: { in: referenceIds } },
          select: { referenceId: true, amount: true },
        }),
        contentClient.getEpisodesBatch(unlocks.map((u) => u.episodeId)),
      ]);

      const spentMap = new Map(debitTxs.map((tx) => [tx.referenceId, Math.abs(tx.amount)]));
      const episodeMap = new Map(episodeDetails.map((ep) => [ep.id, ep]));

      const data = unlocks.map((unlock) => {
        const ep = episodeMap.get(unlock.episodeId);
        const refId = `unlock:${userId}:${unlock.episodeId}`;
        return {
          episodeId: unlock.episodeId,
          title: ep?.title ?? null,
          thumbnail: ep?.thumbnail ?? null,
          seriesName: ep?.seriesTitle ?? null,
          coinsSpent: spentMap.get(refId) ?? null,
          unlockedAt: unlock.createdAt,
        };
      });

      return {
        success: true,
        data,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // ── Streak routes ────────────────────────────────────────────────────────────

  app.get("/streak/status", async (request, reply) => {
    const userId = request.headers["x-user-id"] as string;
    if (!userId) return reply.code(401).send({ error: "User not authenticated" });
    const status = await streakService.getStatus(userId);
    return { success: true, data: status };
  });

  app.post("/streak/claim", async (request, reply) => {
    const userId = request.headers["x-user-id"] as string;
    if (!userId) return reply.code(401).send({ error: "User not authenticated" });
    try {
      const result = await streakService.claim(userId);
      return { success: true, data: result };
    } catch (err: any) {
      if (err.code === "STREAK_DISABLED")
        return reply.code(403).send({ error: err.message });
      if (err.code === "ALREADY_CLAIMED_TODAY")
        return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get(
    "/streak/history",
    { schema: { querystring: z.object({ page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) }) } },
    async (request, reply) => {
      const userId = request.headers["x-user-id"] as string;
      if (!userId) return reply.code(401).send({ error: "User not authenticated" });
      const { page, limit } = request.query as { page: number; limit: number };
      const history = await streakService.getHistory(userId, page, limit);
      return { success: true, data: history };
    }
  );
}
