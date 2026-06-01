
import { FastifyPluginAsync } from "fastify";
import crypto from "crypto";
import { loadConfig } from "../config";
import { getPrisma } from "../lib/prisma";
import { getRazorpay } from "../lib/razorpay";
import { SubscriptionStatus, TransactionSource } from "@prisma/client";
import { invalidateEntitlementCache } from "../lib/redis";
import { CoinService } from "../services/coinService";
import { NotificationClient } from "../clients/notification-client";
import { trackSubscriptionEvent } from "../lib/analytics";

const coinService = new CoinService();
const notificationClient = new NotificationClient();

const webhookRoutes: FastifyPluginAsync = async (app) => {
    const config = loadConfig();
    const prisma = getPrisma();
    const razorpay = getRazorpay();

    app.post("/razorpay", async (request, reply) => {
        const signature = request.headers["x-razorpay-signature"] as string;
        const body = request.body as any;
        const rawBody = (request as any).rawBody;

        if (!signature) {
            return reply.code(400).send({ error: "Missing signature" });
        }

        // Verify signature using raw body if available, fallback to stringified body
        const hmac = crypto.createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET);
        if (rawBody) {
            hmac.update(rawBody);
        } else {
            hmac.update(JSON.stringify(body));
        }
        const generatedSignature = hmac.digest("hex");

        if (generatedSignature !== signature) {
            request.log.warn({
                msg: "Invalid webhook signature",
                signature,
                generatedSignature,
                hasRawBody: !!rawBody
            });
            return reply.code(400).send({ error: "Invalid signature" });
        }

        const event = body.event;
        const payload = body.payload;

        request.log.info({ msg: "Received Razorpay webhook", event, subscriptionId: payload?.subscription?.entity?.id });

        try {
            if (event === "subscription.charged" || event === "invoice.paid") {
                const isInvoice = !!payload.invoice?.entity && !payload.subscription?.entity;
                const subscriptionEntity = payload.subscription?.entity || payload.invoice?.entity;
                const payment = payload.payment?.entity || payload.invoice?.entity?.payment_id;

                if (!subscriptionEntity) {
                    return reply.send({ status: "skipped", reason: "no_subscription_entity" });
                }

                const subscriptionId = isInvoice ? subscriptionEntity.subscription_id : subscriptionEntity.id;
                const paymentId = typeof payment === 'string' ? payment : payment?.id;
                // Invoice entities use billing_end, subscription entities use current_end
                if (isInvoice && subscriptionEntity.billing_end && !subscriptionEntity.current_end) {
                    subscriptionEntity.current_end = subscriptionEntity.billing_end;
                }

                // 1. Try to find a pending transaction for this subscription (Initial purchase)
                // Also check FAILED — happens when user taps buy twice and first tx gets marked FAILED
                let transaction = await prisma.transaction.findFirst({
                    where: { subscriptionId: subscriptionId, status: "PENDING" }
                });
                if (!transaction) {
                    const failedTx = await prisma.transaction.findFirst({
                        where: { subscriptionId: subscriptionId, status: "FAILED" },
                        orderBy: { createdAt: "desc" }
                    });
                    if (failedTx) {
                        request.log.warn({ msg: "Recovering FAILED transaction on subscription.charged", subscriptionId, txId: failedTx.id });
                        transaction = failedTx;
                    }
                }

                if (transaction) {
                    await prisma.transaction.update({
                        where: { id: transaction.id },
                        data: {
                            status: "SUCCESS",
                            razorpayPaymentId: paymentId,
                            razorpaySignature: signature
                        }
                    });

                    // Guard: Check if verify endpoint already created this subscription (race condition)
                    const alreadyCreated = await prisma.userSubscription.findFirst({
                        where: { razorpayOrderId: subscriptionId }
                    });

                    if (alreadyCreated) {
                        request.log.info({ msg: "UserSubscription already exists (verify won the race), skipping creation", subscriptionId });
                        await invalidateEntitlementCache(transaction.userId);
                    } else {
                        // If user is upgrading from trial, expire the old trial subscription
                        const isTrial = !!transaction.trialPlanId;
                        if (!isTrial) {
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

                                if (existingTrialSub.razorpayOrderId) {
                                    try {
                                        await razorpay.subscriptions.cancel(existingTrialSub.razorpayOrderId);
                                        request.log.info({ msg: "Cancelled old trial Razorpay sub during webhook upgrade", oldRpSubId: existingTrialSub.razorpayOrderId });
                                    } catch (cancelErr) {
                                        request.log.warn(cancelErr, "Failed to cancel old trial on Razorpay from webhook");
                                    }
                                }
                            }
                        }

                        // For trial purchases, Razorpay's current_start/current_end reflect the
                        // first billing period (after trial ends), not the trial window itself.
                        // Always use the admin-configured trialPlan.durationDays for the trial period.
                        let subStartsAt = new Date(subscriptionEntity.current_start * 1000);
                        let subEndsAt = new Date(subscriptionEntity.current_end * 1000);
                        let trialDays = 0;
                        if (isTrial && transaction.trialPlanId) {
                            const trialPlanRecord = await prisma.trialPlan.findUnique({ where: { id: transaction.trialPlanId } });
                            if (trialPlanRecord) {
                                subStartsAt = new Date();
                                subEndsAt = new Date(Date.now() + trialPlanRecord.durationDays * 24 * 60 * 60 * 1000);
                                trialDays = trialPlanRecord.durationDays;
                            }
                        }

                        // Activate user subscription - use TRIAL status if this is a trial purchase
                        let userSubscription;
                        try {
                            userSubscription = await prisma.userSubscription.create({
                                data: {
                                    userId: transaction.userId,
                                    planId: transaction.planId,
                                    trialPlanId: transaction.trialPlanId,
                                    status: isTrial ? "TRIAL" : "ACTIVE",
                                    razorpayOrderId: subscriptionId,
                                    transactionId: transaction.id,
                                    provider: "razorpay",
                                    startsAt: subStartsAt,
                                    endsAt: subEndsAt,
                                }
                            });
                        } catch (err: any) {
                            if (err?.code === "P2002") {
                                // Duplicate webhook delivery — concurrent call already created the subscription
                                request.log.info({ msg: "subscription.charged: duplicate webhook, subscription already created", subscriptionId });
                                await invalidateEntitlementCache(transaction.userId);
                                return reply.send({ status: "ok" });
                            }
                            throw err;
                        }

                        request.log.info({ msg: `Subscription ${isTrial ? 'trial' : ''} activated from pending transaction`, userSubscriptionId: userSubscription.id });
                        await invalidateEntitlementCache(transaction.userId);

                        if (isTrial) {
                            void trackSubscriptionEvent(transaction.userId, 'trial_activated', { plan_id: transaction.planId ?? '', trial_days: trialDays });
                            const priorTrials = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: { not: null }, id: { not: userSubscription.id } } });
                            if (priorTrials === 0) void trackSubscriptionEvent(transaction.userId, 'first_trial_purchased', { plan_id: transaction.planId ?? '', trial_days: trialDays });
                        } else {
                            void trackSubscriptionEvent(transaction.userId, 'subscription_activated', { plan_id: transaction.planId ?? '' });
                            const priorPaidSubs = await prisma.userSubscription.count({ where: { userId: transaction.userId, trialPlanId: null, id: { not: userSubscription.id } } });
                            if (priorPaidSubs === 0) void trackSubscriptionEvent(transaction.userId, 'first_subscription_purchased', { plan_id: transaction.planId ?? '' });
                        }
                        if (!(await notificationClient.hasSentRecently(transaction.userId, "SUBSCRIPTION_ACTIVATED"))) {
                            await notificationClient.sendPush(
                                transaction.userId,
                                isTrial ? "Free Trial Activated!" : "Subscription Activated",
                                isTrial
                                    ? `Your ${trialDays} day trial has been activated. Enjoy watching the episodes!`
                                    : "Your subscription is now active. Enjoy unlimited content!",
                                { type: "SUBSCRIPTION_ACTIVATED" }
                            );
                        }
                    }
                } else {
                    // 2. Might be a renewal or trial transition
                    request.log.info({ msg: "Subscription charged for renewal or trial transition", subscriptionId });

                    const existingSub = await prisma.userSubscription.findFirst({
                        where: { razorpayOrderId: subscriptionId }
                    });

                    if (!existingSub) {
                        // Payment captured on Razorpay but no UserSubscription record in DB.
                        // Log full payload so it can be manually replayed via fix script.
                        request.log.error({
                            msg: "UNMATCHED_WEBHOOK: subscription.charged has no UserSubscription record — manual fix required",
                            subscriptionId,
                            paymentId,
                            amountPaise: payload.payment?.entity?.amount,
                            razorpayCustomerId: payload.subscription?.entity?.customer_id,
                            webhookPayload: payload,
                        });
                    } else {
                        // Only block renewal if user explicitly cancelled OR it was a trial superseded by upgrade.
                        // Do NOT use a time-based grace window — if Razorpay fired subscription.charged,
                        // payment is confirmed regardless of how long ago endsAt was.
                        const isSupersededTrial = existingSub.status === "EXPIRED" && !!existingSub.trialPlanId;

                        if (existingSub.status === "CANCELED" || isSupersededTrial) {
                            request.log.info({
                                msg: "Skipping renewal for terminated subscription",
                                subscriptionId,
                                userId: existingSub.userId,
                                status: existingSub.status,
                                isSupersededTrial,
                            });
                            try {
                                await razorpay.subscriptions.cancel(subscriptionId, false);
                            } catch (cancelErr) {
                                request.log.warn(cancelErr, "Failed to cancel Razorpay subscription after skipping reactivation");
                            }
                            return reply.send({ status: "ok" });
                        }

                        // Idempotency: skip if this exact payment was already recorded
                        if (paymentId) {
                            const existingTx = await prisma.transaction.findFirst({
                                where: { razorpayPaymentId: paymentId, status: "SUCCESS" }
                            });
                            if (existingTx) {
                                request.log.info({ msg: "Duplicate webhook — payment already processed", paymentId });
                                return reply.send({ status: "ok" });
                            }
                        }

                        // Validate current_end before using it — missing value would set endsAt to Invalid Date
                        if (!subscriptionEntity.current_end) {
                            request.log.error({ msg: "Renewal payload missing current_end — cannot set endsAt", subscriptionId, paymentId, webhookPayload: payload });
                            return reply.code(500).send({ error: "Missing current_end in renewal payload" });
                        }

                        const wasTrialSub = !!existingSub.trialPlanId;
                        const amountPaise: number = payload.payment?.entity?.amount ?? 0;
                        const currency: string = payload.payment?.entity?.currency ?? "INR";
                        const newEndsAt = new Date(subscriptionEntity.current_end * 1000);

                        if (amountPaise === 0) {
                            request.log.warn({ msg: "Renewal payment has amountPaise=0 — recording but flagging", subscriptionId, paymentId });
                        }

                        // Atomic: update subscription + create transaction in one DB transaction
                        await prisma.$transaction([
                            prisma.userSubscription.update({
                                where: { id: existingSub.id },
                                data: {
                                    status: "ACTIVE",
                                    endsAt: newEndsAt,
                                    trialPlanId: null,
                                }
                            }),
                            prisma.transaction.create({
                                data: {
                                    userId: existingSub.userId,
                                    planId: existingSub.planId,
                                    amountPaise,
                                    currency,
                                    status: "SUCCESS",
                                    subscriptionId,
                                    razorpayPaymentId: paymentId,
                                    provider: "razorpay",
                                    createdAt: new Date(),
                                }
                            }),
                        ]);

                        await invalidateEntitlementCache(existingSub.userId);

                        request.log.info({
                            msg: wasTrialSub ? "TRIAL-TO-PAID TRANSITION" : "Subscription renewed",
                            subId: existingSub.id,
                            userId: existingSub.userId,
                            amountPaise,
                            newEndsAt,
                        });

                        if (wasTrialSub) {
                            void trackSubscriptionEvent(existingSub.userId, 'subscription_activated', { plan_id: existingSub.planId ?? '' });
                            const priorPaidSubs = await prisma.userSubscription.count({ where: { userId: existingSub.userId, trialPlanId: null, id: { not: existingSub.id } } });
                            if (priorPaidSubs === 0) void trackSubscriptionEvent(existingSub.userId, 'first_subscription_purchased', { plan_id: existingSub.planId ?? '' });
                        } else {
                            void trackSubscriptionEvent(existingSub.userId, 'subscription_renewed', { plan_id: existingSub.planId ?? '' });
                        }

                        await notificationClient.sendPush(
                            existingSub.userId,
                            wasTrialSub ? "Subscription Activated" : "Subscription Renewed",
                            wasTrialSub
                                ? "Your trial has ended and your paid subscription is now active."
                                : "Your subscription has been renewed successfully. Keep enjoying premium content!",
                            { type: wasTrialSub ? "SUBSCRIPTION_ACTIVATED" : "SUBSCRIPTION_RENEWED" }
                        );
                    }
                }
            } else if (event === "subscription.activated") {
                const subscriptionEntity = payload.subscription?.entity;
                if (!subscriptionEntity) return reply.send({ status: "skipped" });

                const subscriptionId = subscriptionEntity.id;

                const existingSub = await prisma.userSubscription.findFirst({
                    where: { razorpayOrderId: subscriptionId }
                });

                if (existingSub) {
                    // User cancelled (CANCELED) or we superseded the sub (EXPIRED, e.g., trial→paid upgrade).
                    // Either way, do not activate. Force-cancel Razorpay to stop future charges.
                    if (existingSub.status === "CANCELED" || existingSub.status === "EXPIRED") {
                        request.log.info({ msg: "Skipping subscription.activated for terminated subscription", subscriptionId, userId: existingSub.userId, status: existingSub.status });
                        try {
                            await razorpay.subscriptions.cancel(subscriptionId, false);
                        } catch (cancelErr) {
                            request.log.warn(cancelErr, "Force-cancel on activated-but-terminated subscription failed");
                        }
                        return reply.send({ status: "ok" });
                    }

                    // Razorpay fires subscription.activated at mandate authentication time
                    // (immediately after user pays), not only when the billing period starts.
                    // For trial subs, this fires BEFORE the trial ends with current_start/current_end
                    // pointing at the future billing period (30 days out). Activating here would:
                    //   1. Overwrite the correct trial endsAt with the billing period end (30 days)
                    //   2. Clear trialPlanId, breaking the isCancelledTrial check in subscription.cancelled
                    // Skip — subscription.charged handles TRIAL→ACTIVE when the charge actually succeeds.
                    if (existingSub.status === "TRIAL" && existingSub.trialPlanId) {
                        request.log.info({ msg: "Skipping subscription.activated during active trial — subscription.charged will handle transition", subscriptionId });
                        return reply.send({ status: "ok" });
                    }

                    // If this was a trial subscription, transition to ACTIVE (trial is ending)
                    const wasTrialSub = !!existingSub.trialPlanId || existingSub.status === "TRIAL";

                    await prisma.userSubscription.update({
                        where: { id: existingSub.id },
                        data: {
                            status: "ACTIVE",
                            trialPlanId: wasTrialSub ? null : existingSub.trialPlanId,
                            startsAt: new Date(subscriptionEntity.current_start * 1000),
                            endsAt: new Date(subscriptionEntity.current_end * 1000)
                        }
                    });

                    await invalidateEntitlementCache(existingSub.userId);
                    if (wasTrialSub) {
                        request.log.info({
                            msg: "TRIAL-TO-PAID TRANSITION via subscription.activated",
                            subId: existingSub.id,
                            userId: existingSub.userId
                        });
                    }
                } else {
                    // Search transaction to find user and plan
                    const tx = await prisma.transaction.findFirst({
                        where: { subscriptionId: subscriptionId }
                    });
                    if (tx) {
                        // If user is upgrading from trial, expire the old trial subscription
                        const isTrial = !!tx.trialPlanId;
                        if (!isTrial) {
                            const existingTrialSub = await prisma.userSubscription.findFirst({
                                where: {
                                    userId: tx.userId,
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

                                if (existingTrialSub.razorpayOrderId) {
                                    try {
                                        await razorpay.subscriptions.cancel(existingTrialSub.razorpayOrderId);
                                        request.log.info({ msg: "Cancelled old trial Razorpay sub during activated webhook upgrade", oldRpSubId: existingTrialSub.razorpayOrderId });
                                    } catch (cancelErr) {
                                        request.log.warn(cancelErr, "Failed to cancel old trial on Razorpay from activated webhook");
                                    }
                                }
                            }
                        }

                        let startsAt = new Date(subscriptionEntity.current_start * 1000);
                        let endsAt = new Date(subscriptionEntity.current_end * 1000);
                        let trialDays = 0;
                        if (isTrial && tx.trialPlanId) {
                            const trialPlanRecord = await prisma.trialPlan.findUnique({ where: { id: tx.trialPlanId } });
                            if (trialPlanRecord) {
                                startsAt = new Date();
                                endsAt = new Date(Date.now() + trialPlanRecord.durationDays * 24 * 60 * 60 * 1000);
                                trialDays = trialPlanRecord.durationDays;
                            }
                        }

                        let newSub;
                        try {
                            newSub = await prisma.userSubscription.create({
                                data: {
                                    userId: tx.userId,
                                    planId: tx.planId,
                                    trialPlanId: tx.trialPlanId,
                                    status: isTrial ? "TRIAL" : "ACTIVE",
                                    razorpayOrderId: subscriptionId,
                                    transactionId: tx.id,
                                    provider: "razorpay",
                                    startsAt,
                                    endsAt,
                                }
                            });
                        } catch (err: any) {
                            if (err?.code === "P2002") {
                                request.log.info({ msg: "subscription.activated: duplicate webhook, subscription already created", subscriptionId });
                                await invalidateEntitlementCache(tx.userId);
                                return reply.send({ status: "ok" });
                            }
                            throw err;
                        }
                        await invalidateEntitlementCache(tx.userId);

                        if (isTrial) {
                            void trackSubscriptionEvent(tx.userId, 'trial_activated', { plan_id: tx.planId ?? '', trial_days: trialDays });
                            const priorTrials = await prisma.userSubscription.count({ where: { userId: tx.userId, trialPlanId: { not: null }, id: { not: newSub.id } } });
                            if (priorTrials === 0) void trackSubscriptionEvent(tx.userId, 'first_trial_purchased', { plan_id: tx.planId ?? '', trial_days: trialDays });
                        } else {
                            void trackSubscriptionEvent(tx.userId, 'subscription_activated', { plan_id: tx.planId ?? '' });
                            const priorPaidSubs = await prisma.userSubscription.count({ where: { userId: tx.userId, trialPlanId: null, id: { not: newSub.id } } });
                            if (priorPaidSubs === 0) void trackSubscriptionEvent(tx.userId, 'first_subscription_purchased', { plan_id: tx.planId ?? '' });
                        }
                        if (tx.status === "PENDING") {
                            await prisma.transaction.update({
                                where: { id: tx.id },
                                data: { status: "SUCCESS" }
                            });
                        }
                        if (!(await notificationClient.hasSentRecently(tx.userId, "SUBSCRIPTION_ACTIVATED"))) {
                            await notificationClient.sendPush(
                                tx.userId,
                                isTrial ? "Free Trial Activated!" : "Subscription Activated",
                                isTrial
                                    ? `Your ${trialDays} day trial has been activated. Enjoy watching the episodes!`
                                    : "Your subscription is now active. Enjoy unlimited content!",
                                { type: "SUBSCRIPTION_ACTIVATED" }
                            );
                        }
                    }
                }
            } else if (
                event === "subscription.cancelled" ||
                event === "subscription.halted" ||
                event === "subscription.completed"
            ) {
                const subscriptionEntity = payload.subscription.entity;
                const subscriptionId = subscriptionEntity.id;

                const status: SubscriptionStatus = event === "subscription.completed" ? "EXPIRED" : "CANCELED";

                const existingSub = await prisma.userSubscription.findFirst({
                    where: { razorpayOrderId: subscriptionId }
                });

                if (existingSub) {
                    const isCancelledTrial = event === "subscription.cancelled" && !!existingSub.trialPlanId;

                    await prisma.userSubscription.update({
                        where: { id: existingSub.id },
                        data: { status }
                    });
                    await invalidateEntitlementCache(existingSub.userId);
                    request.log.info({ msg: `Subscription ${event}`, subscriptionId, status, isCancelledTrial });

                    if (event === "subscription.cancelled") {
                        const daysActive = Math.floor((Date.now() - existingSub.startsAt.getTime()) / (1000 * 86400));
                        if (isCancelledTrial) {
                            void trackSubscriptionEvent(existingSub.userId, 'trial_cancelled', { plan_id: existingSub.planId ?? '', days_in_trial: daysActive });
                        } else {
                            void trackSubscriptionEvent(existingSub.userId, 'subscription_cancelled', { plan_id: existingSub.planId ?? '', days_active: daysActive });
                        }
                    }

                    // Force immediate cancellation on Razorpay for trials so the paid period
                    // that follows the trial is never charged.
                    if (isCancelledTrial) {
                        try {
                            await razorpay.subscriptions.cancel(subscriptionId, false);
                            request.log.info({ msg: "Force-cancelled Razorpay trial subscription to block paid-period charge", subscriptionId });
                        } catch (cancelErr) {
                            request.log.warn(cancelErr, "Force-cancel failed — may already be fully cancelled");
                        }
                    }

                    if (event === "subscription.halted") {
                        await notificationClient.sendPush(
                            existingSub.userId,
                            "Payment Failed",
                            "We couldn't process your subscription payment. Please update your payment method to continue.",
                            { type: "SUBSCRIPTION_PAYMENT_FAILED" }
                        );
                    }
                }
            } else if (event === "payment.captured" || event === "order.paid") {
                const isOrder = event === "order.paid";
                const entity = isOrder ? payload.order?.entity : payload.payment?.entity;

                if (entity?.notes?.type === "COIN_PURCHASE") {
                    const orderId = isOrder ? entity.id : entity.order_id;
                    const paymentId = isOrder ? null : entity.id;
                    const userId = entity.notes.userId;

                    const purchase = await prisma.userCoinPurchase.findUnique({
                        where: { orderId }
                    });

                    if (purchase && purchase.status !== "SUCCESS") {
                        await prisma.$transaction(async (tx) => {
                            await tx.userCoinPurchase.update({
                                where: { id: purchase.id },
                                data: {
                                    status: "SUCCESS",
                                    paymentId: paymentId || purchase.paymentId,
                                }
                            });

                            await coinService.creditCoins({
                                userId: purchase.userId,
                                amount: purchase.coins,
                                source: TransactionSource.PURCHASE,
                                referenceId: orderId,
                            }, tx);
                        });
                        request.log.info({ msg: "Coin purchase fulfilled via webhook", orderId, userId });
                        await notificationClient.sendPush(
                            purchase.userId,
                            "Coins Added!",
                            `${purchase.coins} coins added! Use coins to unlock episodes.`,
                            { type: "COIN_PURCHASE_SUCCESS", coins: String(purchase.coins) }
                        );
                    }
                }
            } else if (event === "payment.failed") {
                const entity = payload.payment?.entity;
                if (entity?.notes?.type === "COIN_PURCHASE") {
                    const orderId = entity.order_id;
                    const purchase = await prisma.userCoinPurchase.findUnique({
                        where: { orderId }
                    });
                    if (purchase && purchase.status === "CREATED") {
                        await prisma.userCoinPurchase.update({
                            where: { id: purchase.id },
                            data: { status: "FAILED" }
                        });
                        request.log.info({ msg: "Coin purchase marked FAILED via webhook", orderId });
                        await notificationClient.sendPush(
                            purchase.userId,
                            "Payment Failed",
                            "Your coin purchase could not be processed. Please try again.",
                            { type: "COIN_PURCHASE_FAILED" }
                        );
                    }
                }
            }

            return reply.send({ status: "ok" });
        } catch (err) {
            // Log full payload so the event can be manually replayed if needed
            request.log.error({
                msg: "Webhook processing failed",
                event,
                subscriptionId: payload?.subscription?.entity?.id,
                paymentId: payload?.payment?.entity?.id,
                err,
                webhookPayload: payload,
            });
            return reply.code(500).send({ error: "Webhook processing failed" });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PhonePe webhook handler
    // ─────────────────────────────────────────────────────────────────────────
    app.post("/phonepe", async (request, reply) => {
        const { getPhonePe } = await import("../lib/phonepe");
        const phonepe = getPhonePe();
        const authHeader = request.headers["authorization"] as string;

        if (!phonepe.verifyWebhookSignature(authHeader)) {
            request.log.warn({ msg: "Invalid PhonePe webhook signature" });
            return reply.code(401).send({ error: "Unauthorized" });
        }

        const body = request.body as any;
        const event: string = body.event ?? "";
        const payload = body.payload ?? {};

        const merchantOrderId: string | undefined =
            payload.merchantOrderId ?? payload.originalMerchantOrderId;
        const merchantSubscriptionId: string | undefined =
            payload.paymentFlow?.merchantSubscriptionId ?? payload.merchantSubscriptionId;

        await phonepe.logInboundWebhook({
            userId: undefined,
            merchantOrderId,
            merchantSubscriptionId,
            eventType: event,
            body,
            success: true,
        });

        request.log.info({ msg: "PhonePe webhook received", event, merchantOrderId, merchantSubscriptionId });

        try {
            // ── Mandate setup ──────────────────────────────────────────────
            if (event === "subscription.setup.order.completed") {
                if (merchantSubscriptionId) {
                    const existingSub = await prisma.userSubscription.findFirst({
                        where: { phonePeSubscriptionId: merchantSubscriptionId, status: { in: ["ACTIVE", "TRIAL"] } },
                    });
                    if (existingSub) return reply.send({ success: true }); // already handled by verify
                }
                if (merchantOrderId) {
                    await prisma.transaction.updateMany({
                        where: { metadata: { path: ["merchantOrderId"], equals: merchantOrderId }, status: "PENDING" },
                        data: { status: "SUCCESS" },
                    });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.setup.order.failed") {
                if (merchantOrderId) {
                    await prisma.transaction.updateMany({
                        where: { metadata: { path: ["merchantOrderId"], equals: merchantOrderId }, status: "PENDING" },
                        data: { status: "FAILED", failureReason: payload.errorCode ?? "Setup failed" },
                    });
                }
                return reply.send({ success: true });
            }

            // ── Notify ─────────────────────────────────────────────────────
            if (event === "subscription.notification.completed") {
                if (!merchantOrderId) return reply.send({ success: true });
                const redemption = await prisma.phonePeRedemption.findUnique({ where: { merchantOrderId } });
                if (!redemption || redemption.status === "SUCCESS") return reply.send({ success: true });
                // Only update if still PENDING_NOTIFY — if already NOTIFIED/EXECUTING/beyond, the
                // billing cron already recorded the notification. Resetting EXECUTING→NOTIFIED would
                // restart the 24h cooling window on an in-flight payment and risk a double-execute.
                if (redemption.status === "PENDING_NOTIFY") {
                    const notifiedAt = new Date();
                    await prisma.phonePeRedemption.update({
                        where: { merchantOrderId },
                        data: {
                            status: "NOTIFIED",
                            notifiedAt,
                            notifyWindowEnd: new Date(notifiedAt.getTime() + 72 * 60 * 60 * 1000),
                        },
                    });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.notification.failed") {
                request.log.warn({ msg: "PhonePe notify failed", merchantOrderId, errorCode: payload.errorCode });
                return reply.send({ success: true }); // cron will retry
            }

            // ── Redemption completed ───────────────────────────────────────
            if (event === "subscription.redemption.order.completed") {
                if (!merchantOrderId) return reply.send({ success: true });
                const redemption = await prisma.phonePeRedemption.findUnique({
                    where: { merchantOrderId },
                    include: { userSubscription: { include: { plan: true } } },
                });
                if (!redemption) return reply.send({ success: true });

                let didProcess = false;
                await prisma.$transaction(async (tx) => {
                    const locked = await tx.phonePeRedemption.updateMany({
                        where: { merchantOrderId, status: { not: "SUCCESS" } },
                        data: { status: "SUCCESS" },
                    });
                    if (locked.count === 0) return;
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
                            request.log.error({ msg: "phonepe_webhook: failed to create next cycle redemption — manual check needed", merchantOrderId, error: err?.message });
                        }
                    }
                });

                if (didProcess) {
                    await invalidateEntitlementCache(redemption.userId);
                    void notificationClient.sendPush(
                        redemption.userId, "Subscription Renewed",
                        "Your subscription has been renewed successfully!",
                        { type: "SUBSCRIPTION_RENEWED" }
                    );
                    void trackSubscriptionEvent(redemption.userId, "subscription_renewed", {
                        plan_id: redemption.userSubscription.planId ?? "",
                        provider: "phonepe", cycle_number: redemption.cycleNumber,
                    });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.redemption.order.failed") {
                if (!merchantOrderId) return reply.send({ success: true });
                const redemption = await prisma.phonePeRedemption.findUnique({ where: { merchantOrderId } });
                if (!redemption || redemption.status === "SUCCESS" || redemption.status === "FAILED") return reply.send({ success: true });

                const nonRetryableCodes = new Set([
                    "TRANSACTION_NOT_PERMITTED", "SUBSCRIPTION_INVALID", "SUBSCRIPTION_CANCELLED",
                    "SUBSCRIPTION_PAUSED", "MANDATE_LIMIT_EXCEEDED", "FREQUENCY_EXCEEDED",
                    "INVALID_TRANSACTION", "AUTHORIZATION_FAILURE",
                ]);
                const isNonRetryable = payload.errorCode && nonRetryableCodes.has(payload.errorCode);
                const newAttempts = redemption.executeAttempts + 1;
                const windowExpiring = redemption.notifyWindowEnd
                    ? redemption.notifyWindowEnd.getTime() - Date.now() < 2 * 60 * 60 * 1000
                    : false;

                const permanentFail = isNonRetryable || newAttempts >= 3 || windowExpiring;

                if (permanentFail) {
                    let didFail = false;
                    await prisma.$transaction(async (tx) => {
                        const result = await tx.phonePeRedemption.updateMany({
                            where: { merchantOrderId, status: { notIn: ["SUCCESS", "FAILED"] } },
                            data: { status: "FAILED", executeAttempts: newAttempts, lastError: payload.errorCode },
                        });
                        if (result.count === 0) return;
                        await tx.userSubscription.update({
                            where: { id: redemption.userSubscriptionId },
                            data: { status: "CANCELED" },
                        });
                        didFail = true;
                    });
                    if (didFail) {
                        await invalidateEntitlementCache(redemption.userId);
                        try { await phonepe.cancelSubscription(redemption.merchantSubscriptionId, redemption.userId) } catch {}
                        void notificationClient.sendPush(
                            redemption.userId, "Payment Failed",
                            "We couldn't renew your subscription. Please resubscribe to continue watching.",
                            { type: "SUBSCRIPTION_PAYMENT_FAILED" }
                        );
                        void trackSubscriptionEvent(redemption.userId, "subscription_payment_failed", {
                            provider: "phonepe", error_code: payload.errorCode, attempts: newAttempts,
                        });
                    }
                } else {
                    await prisma.phonePeRedemption.update({
                        where: { merchantOrderId },
                        data: { status: "NOTIFIED", executeAttempts: newAttempts, lastError: payload.errorCode },
                    });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.redemption.transaction.completed") {
                if (merchantOrderId && payload.paymentDetails?.[0]) {
                    const detail = payload.paymentDetails[0];
                    await prisma.phonePeRedemption.updateMany({
                        where: { merchantOrderId },
                        data: { metadata: { utr: detail.rail?.utr, transactionId: detail.transactionId } },
                    });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.redemption.transaction.failed") {
                request.log.warn({ msg: "PhonePe redemption transaction attempt failed", merchantOrderId });
                return reply.send({ success: true });
            }

            // ── Lifecycle events ───────────────────────────────────────────
            if (event === "subscription.paused") {
                if (!merchantSubscriptionId) return reply.send({ success: true });
                await prisma.userSubscription.updateMany({
                    where: { phonePeSubscriptionId: merchantSubscriptionId },
                    data: { status: "PAUSED" },
                });
                const sub = await prisma.userSubscription.findFirst({ where: { phonePeSubscriptionId: merchantSubscriptionId } });
                if (sub) {
                    await invalidateEntitlementCache(sub.userId);
                    void notificationClient.sendPush(sub.userId, "Subscription Paused",
                        "Your subscription mandate has been paused from your UPI app.", { type: "SUBSCRIPTION_PAUSED" });
                }
                return reply.send({ success: true });
            }

            if (event === "subscription.unpaused") {
                if (!merchantSubscriptionId) return reply.send({ success: true });
                await prisma.userSubscription.updateMany({
                    where: { phonePeSubscriptionId: merchantSubscriptionId, status: "PAUSED" },
                    data: { status: "ACTIVE" },
                });
                const unpausedSub = await prisma.userSubscription.findFirst({ where: { phonePeSubscriptionId: merchantSubscriptionId } });
                if (unpausedSub) await invalidateEntitlementCache(unpausedSub.userId);
                return reply.send({ success: true });
            }

            if (event === "subscription.revoked" || event === "subscription.cancelled") {
                if (!merchantSubscriptionId) return reply.send({ success: true });
                const sub = await prisma.userSubscription.findFirst({
                    where: { phonePeSubscriptionId: merchantSubscriptionId },
                });
                if (!sub || sub.status === "CANCELED" || sub.status === "EXPIRED") {
                    return reply.send({ success: true }); // idempotent
                }
                await prisma.userSubscription.update({
                    where: { id: sub.id },
                    data: { status: "CANCELED" },
                });
                await invalidateEntitlementCache(sub.userId);
                void notificationClient.sendPush(sub.userId, "Subscription Cancelled",
                    "Your subscription has been cancelled. You'll retain access until the end of your current period.",
                    { type: "SUBSCRIPTION_CANCELLED" });
                void trackSubscriptionEvent(sub.userId, "subscription_cancelled", {
                    provider: "phonepe",
                    reason: event === "subscription.revoked" ? "user_revoked" : "cancelled",
                });
                return reply.send({ success: true });
            }

            if (["pg.refund.completed", "pg.refund.accepted", "pg.refund.failed"].includes(event)) {
                request.log.info({ msg: `PhonePe refund event: ${event}`, payload });
                return reply.send({ success: true });
            }

            request.log.info({ msg: "PhonePe unhandled webhook event", event });
            return reply.send({ success: true });

        } catch (err) {
            request.log.error({ msg: "PhonePe webhook processing error", event, err });
            return reply.code(500).send({ error: "Webhook processing failed" });
        }
    });
};

export default webhookRoutes;
