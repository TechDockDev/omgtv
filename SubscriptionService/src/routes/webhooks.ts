
import { FastifyPluginAsync } from "fastify";
import crypto from "crypto";
import { loadConfig } from "../config";
import { getPrisma } from "../lib/prisma";
import { getRazorpay } from "../lib/razorpay";
import { SubscriptionStatus } from "@prisma/client";
import { invalidateEntitlementCache } from "../lib/redis";
import { CoinService } from "../services/coinService";

const coinService = new CoinService();

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

                    // Activate user subscription - use TRIAL status if this is a trial purchase
                    const isTrial = !!transaction.trialPlanId;
                    const userSubscription = await prisma.userSubscription.create({
                        data: {
                            userId: transaction.userId,
                            planId: transaction.planId,
                            trialPlanId: transaction.trialPlanId,
                            status: isTrial ? "TRIAL" : "ACTIVE",
                            razorpayOrderId: subscriptionId,
                            transactionId: transaction.id,
                            startsAt: new Date(subscriptionEntity.current_start * 1000),
                            endsAt: new Date(subscriptionEntity.current_end * 1000)
                        }
                    });

                    request.log.info({ msg: `Subscription ${isTrial ? 'trial' : ''} activated from pending transaction`, userSubscriptionId: userSubscription.id });
                    await invalidateEntitlementCache(transaction.userId);
                } else {
                    // 2. Might be a renewal or trial transition
                    request.log.info({ msg: "Subscription charged for renewal or trial transition", subscriptionId });

                    const existingSub = await prisma.userSubscription.findFirst({
                        where: { razorpayOrderId: subscriptionId }
                    });

                    if (existingSub) {
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
                        } else {
                            request.log.info({ msg: "Subscription renewed", subId: existingSub.id });
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
                        await prisma.userSubscription.create({
                            data: {
                                userId: tx.userId,
                                planId: tx.planId,
                                trialPlanId: tx.trialPlanId,
                                status: tx.trialPlanId ? "TRIAL" : "ACTIVE",
                                razorpayOrderId: subscriptionId,
                                transactionId: tx.id,
                                startsAt: new Date(subscriptionEntity.current_start * 1000),
                                endsAt: new Date(subscriptionEntity.current_end * 1000)
                            }
                        });
                        await invalidateEntitlementCache(tx.userId);
                        if (tx.status === "PENDING") {
                           await prisma.transaction.update({
                               where: { id: tx.id },
                               data: { status: "SUCCESS" }
                           });
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
                    await prisma.userSubscription.update({
                        where: { id: existingSub.id },
                        data: { status }
                    });
                    await invalidateEntitlementCache(existingSub.userId);
                    request.log.info({ msg: `Subscription ${event}`, subscriptionId, status });
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
                                source: "PURCHASE",
                                referenceId: orderId,
                            }, tx);
                        });
                        request.log.info({ msg: "Coin purchase fulfilled via webhook", orderId, userId });
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
