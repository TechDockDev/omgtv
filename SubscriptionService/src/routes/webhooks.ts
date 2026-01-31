
import { FastifyPluginAsync } from "fastify";
import crypto from "crypto";
import { loadConfig } from "../config";
import { getPrisma } from "../lib/prisma";
import { getRazorpay } from "../lib/razorpay";
import { Transaction, UserSubscription, SubscriptionStatus } from "@prisma/client";

const webhookRoutes: FastifyPluginAsync = async (app) => {
    const config = loadConfig();
    const prisma = getPrisma();
    const razorpay = getRazorpay();

    app.post("/razorpay", async (request, reply) => {
        const signature = request.headers["x-razorpay-signature"] as string;
        const body = request.body as any;

        if (!signature) {
            return reply.code(400).send({ error: "Missing signature" });
        }

        // Verify signature
        const hmac = crypto.createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET);
        hmac.update(JSON.stringify(body));
        const generatedSignature = hmac.digest("hex");

        if (generatedSignature !== signature) {
            request.log.warn({ msg: "Invalid webhook signature", signature, generatedSignature });
            return reply.code(400).send({ error: "Invalid signature" });
        }

        const event = body.event;
        const payload = body.payload;

        request.log.info({ msg: "Received Razorpay webhook", event, payloadId: payload?.payment?.entity?.id });

        try {
            if (event === "payment.captured") {
                const payment = payload.payment.entity;
                // Check if this payment is for a subscription or an order
                // For new flow, we might receive subscription events like 'subscription.charged'
                // But let's handle 'payment.captured' first as it's common.
                // However, for subscriptions, 'subscription.charged' is better.
                // Let's stick to what was likely planned: handling payment success.

                // Note: With subscriptions, 'order_id' in payment entity corresponds to the specific order for that billing cycle.
                // The 'subscription_id' field in payment entity links to our transaction/subscription.

                // Let's handle 'subscription.charged' which is critical for recurring.
                // And also 'order.paid' or 'payment.captured'.
            } else if (event === "subscription.charged") {
                const subscriptionEntity = payload.subscription.entity;
                const payment = payload.payment.entity;

                const subscriptionId = subscriptionEntity.id;
                const paymentId = payment.id;

                // Find transaction by subscription ID (stored in razorpayOrderId)
                // OR find UserSubscription by razorpayOrderId

                // In our intent, we did:
                // Transaction.razorpayOrderId = subscription.id

                const transaction = await prisma.transaction.findFirst({
                    where: {
                        subscriptionId: subscriptionId,
                        status: "PENDING"
                    }
                });

                if (transaction) {
                    // Update transaction
                    await prisma.transaction.update({
                        where: { id: transaction.id },
                        data: {
                            status: "SUCCESS",
                            razorpayPaymentId: paymentId,
                            razorpaySignature: signature // saving webhook signature as proof? or empty
                        }
                    });

                    // Activate user subscription
                    const userSubscription = await prisma.userSubscription.create({
                        data: {
                            userId: transaction.userId,
                            planId: transaction.planId,
                            status: "ACTIVE",
                            razorpayOrderId: subscriptionId,
                            transactionId: transaction.id,
                            startsAt: new Date(subscriptionEntity.current_start * 1000),
                            endsAt: new Date(subscriptionEntity.current_end * 1000)
                        }
                    });

                    request.log.info({ msg: "Subscription activated", userSubscriptionId: userSubscription.id });
                } else {
                    // Might be a renewal
                    request.log.info({ msg: "Subscription charged for renewal or unknown transaction", subscriptionId });
                    // Handle renewal logic here: find existing UserSubscription and update endsAt + create new Transaction

                    const existingSub = await prisma.userSubscription.findFirst({
                        where: {
                            OR: [
                                { razorpayOrderId: subscriptionId },
                                // In new schema, we might store subscriptionId explicitly if we had a field, 
                                // but UserSubscription mainly has razorpayOrderId as the external ID.
                                // Let's check if we need to migrate this look up.
                                // UserSubscription schema: razorpayOrderId String?
                                // So we keep checking razorpayOrderId here as that's where we store the sub ID in UserSubscription table.
                                { razorpayOrderId: subscriptionId }
                            ]
                        }
                    });

                    if (existingSub) {
                        await prisma.userSubscription.update({
                            where: { id: existingSub.id },
                            data: {
                                status: "ACTIVE",
                                endsAt: new Date(subscriptionEntity.current_end * 1000)
                            }
                        });

                        // Record new transaction
                        await prisma.transaction.create({
                            data: {
                                userId: existingSub.userId,
                                planId: existingSub.planId,
                                amountPaise: payment.amount,
                                currency: payment.currency,
                                status: "SUCCESS",
                                subscriptionId: subscriptionId, // Was razorpayOrderId
                                razorpayPaymentId: paymentId,
                                createdAt: new Date(),
                            }
                        });
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
