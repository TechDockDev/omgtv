
import { FastifyPluginAsync } from "fastify";
import crypto from "crypto";
import { loadConfig } from "../config";
import { getPrisma } from "../lib/prisma";
import { getRazorpay } from "../lib/razorpay";
import { SubscriptionStatus, TransactionSource } from "@prisma/client";
import { invalidateEntitlementCache } from "../lib/redis";
import { CoinService } from "../services/coinService";
import { NotificationClient } from "../clients/notification-client";

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
                const transaction = await prisma.transaction.findFirst({
                    where: {
                        subscriptionId: subscriptionId,
                        status: "PENDING"
                    }
                });

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
                        const userSubscription = await prisma.userSubscription.create({
                            data: {
                                userId: transaction.userId,
                                planId: transaction.planId,
                                trialPlanId: transaction.trialPlanId,
                                status: isTrial ? "TRIAL" : "ACTIVE",
                                razorpayOrderId: subscriptionId,
                                transactionId: transaction.id,
                                startsAt: subStartsAt,
                                endsAt: subEndsAt,
                            }
                        });

                        request.log.info({ msg: `Subscription ${isTrial ? 'trial' : ''} activated from pending transaction`, userSubscriptionId: userSubscription.id });
                        await invalidateEntitlementCache(transaction.userId);
                        await notificationClient.sendPush(
                            transaction.userId,
                            isTrial ? "Free Trial Activated!" : "Subscription Activated",
                            isTrial
                                ? `Your ${trialDays} day trial has been activated. Enjoy watching the episodes!`
                                : "Your subscription is now active. Enjoy unlimited content!",
                            { type: "SUBSCRIPTION_ACTIVATED" }
                        );
                    }
                } else {
                    // 2. Might be a renewal or trial transition
                    request.log.info({ msg: "Subscription charged for renewal or trial transition", subscriptionId });

                    const existingSub = await prisma.userSubscription.findFirst({
                        where: { razorpayOrderId: subscriptionId }
                    });

                    if (existingSub) {
                        // If the user cancelled auto-renew, the subscription is already CANCELED in our DB.
                        // EXPIRED means we deliberately ended it (e.g., trial→paid upgrade superseded the old sub).
                        // Razorpay may still fire subscription.charged for stale subscriptions, but we must NOT
                        // reactivate one the user (or our own upgrade flow) already terminated.
                        if (existingSub.status === "CANCELED" || existingSub.status === "EXPIRED") {
                            request.log.info({ msg: "Skipping renewal for terminated subscription", subscriptionId, userId: existingSub.userId, status: existingSub.status });
                            // Cancel on Razorpay side immediately to stop further charges
                            try {
                                await razorpay.subscriptions.cancel(subscriptionId, false);
                            } catch (cancelErr) {
                                request.log.warn(cancelErr, "Failed to cancel Razorpay subscription after skipping reactivation");
                            }
                            return reply.send({ status: "ok" });
                        }

                        // Check if we already processed this exact payment
                        let existingTx = null;
                        if (paymentId) {
                            existingTx = await prisma.transaction.findFirst({
                                where: { razorpayPaymentId: paymentId, status: "SUCCESS" }
                            });
                        }

                        if (existingTx) {
                            request.log.info({ msg: "Duplicate webhook for payment already processed", paymentId });
                            return reply.send({ status: "ok" });
                        }

                        // Detect trial-to-paid transition: if trialPlanId was set, this is a renewal after trial
                        const wasTrialSub = !!existingSub.trialPlanId;

                        await prisma.userSubscription.update({
                            where: { id: existingSub.id },
                            data: {
                                status: "ACTIVE",
                                endsAt: new Date(subscriptionEntity.current_end * 1000),
                                trialPlanId: null  // Critical: Trial is over, user is now on full premium plan
                            }
                        });

                        // Record new transaction for the charge
                        await prisma.transaction.create({
                            data: {
                                userId: existingSub.userId,
                                planId: existingSub.planId,
                                amountPaise: payload.payment?.entity?.amount || 0,
                                currency: payload.payment?.entity?.currency || "INR",
                                status: "SUCCESS",
                                subscriptionId: subscriptionId,
                                razorpayPaymentId: paymentId,
                                createdAt: new Date(),
                            }
                        });

                        await invalidateEntitlementCache(existingSub.userId);

                        if (wasTrialSub) {
                            request.log.info({
                                msg: "TRIAL-TO-PAID TRANSITION: Trial ended, subscription now on paid plan",
                                subId: existingSub.id,
                                userId: existingSub.userId,
                                planId: existingSub.planId,
                                newEndsAt: new Date(subscriptionEntity.current_end * 1000)
                            });
                            await notificationClient.sendPush(
                                existingSub.userId,
                                "Subscription Activated",
                                "Your trial has ended and your paid subscription is now active.",
                                { type: "SUBSCRIPTION_ACTIVATED" }
                            );
                        } else {
                            request.log.info({ msg: "Subscription renewed", subId: existingSub.id });
                            await notificationClient.sendPush(
                                existingSub.userId,
                                "Subscription Renewed",
                                "Your subscription has been renewed successfully. Keep enjoying premium content!",
                                { type: "SUBSCRIPTION_RENEWED" }
                            );
                        }
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

                        await prisma.userSubscription.create({
                            data: {
                                userId: tx.userId,
                                planId: tx.planId,
                                trialPlanId: tx.trialPlanId,
                                status: isTrial ? "TRIAL" : "ACTIVE",
                                razorpayOrderId: subscriptionId,
                                transactionId: tx.id,
                                startsAt,
                                endsAt,
                            }
                        });
                        await invalidateEntitlementCache(tx.userId);
                        if (tx.status === "PENDING") {
                           await prisma.transaction.update({
                               where: { id: tx.id },
                               data: { status: "SUCCESS" }
                           });
                        }
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
                        data: {
                            status,
                            // Trial cancel → lose access immediately (endsAt = now).
                            // Paid plan cancel → keep access till current period end (endsAt unchanged).
                            ...(isCancelledTrial ? { endsAt: new Date() } : {}),
                        }
                    });
                    await invalidateEntitlementCache(existingSub.userId);
                    request.log.info({ msg: `Subscription ${event}`, subscriptionId, status, isCancelledTrial });

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
            request.log.error(err);
            return reply.code(500).send({ error: "Webhook processing failed" });
        }
    });
};

export default webhookRoutes;
