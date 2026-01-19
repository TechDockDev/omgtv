import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";

const purchaseIntentSchema = z.object({
  userId: z.string(),
  planId: z.string().uuid(),
  deviceId: z.string().optional(),
});

export default async function customerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get("/plans", async () => {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { pricePaise: 'asc' }
    });

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
      };
    });

    return {
      success: true,
      statusCode: 200,
      userMessage: "Plans retrieved successfully",
      developerMessage: "Public plans retrieved",
      data: formattedPlans,
    };
  });

  app.get("/me/subscription", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    const data = await prisma.userSubscription.findFirst({
      where: { userId },
      orderBy: { startsAt: "desc" },
      include: { plan: true },
    });
    return {
      success: true,
      statusCode: 200,
      userMessage: "Subscription retrieved successfully",
      developerMessage: "User subscription details retrieved",
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
      // Fallback: If razorpayOrderId looks like a subscription (starts with sub_), use that as subscriptionId (migration support)
      subscriptionId: t.subscriptionId || (t.razorpayOrderId?.startsWith("sub_") ? t.razorpayOrderId : null),
      // If razorpayOrderId looks like a subscription, hide it from the orderId field to avoid confusion
      razorpayOrderId: t.razorpayOrderId?.startsWith("sub_") ? null : t.razorpayOrderId
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
    const { userId, planId, deviceId } = request.body as z.infer<typeof purchaseIntentSchema>;
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) {
      return reply.notFound("Plan not found or inactive");
    }

    if (!plan.razorpayPlanId) {
      return reply.badRequest("Plan is not configured for online payments (missing Razorpay Plan ID)");
    }

    const { getRazorpay } = await import("../../lib/razorpay");
    const razorpay = getRazorpay();

    try {
      const subscription = await razorpay.subscriptions.create({
        plan_id: plan.razorpayPlanId,
        customer_notify: 1,
        total_count: 120, // Default to 10 years (120 months) for auto-renew, adjust as per business logic
        quantity: 1,
        notes: {
          userId,
          planId,
          internalPlanId: plan.id
        }
      });

      const transaction = await prisma.transaction.create({
        data: {
          userId,
          planId,
          amountPaise: plan.pricePaise,
          currency: plan.currency,
          subscriptionId: subscription.id,
          razorpayOrderId: null, // Explicitly null for subscriptions
          metadata: deviceId ? { deviceId, subscriptionId: subscription.id } : { subscriptionId: subscription.id },
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
  });

  const verifyPurchaseSchema = z.object({
    paymentId: z.string(),
    subscriptionId: z.string(),
    signature: z.string(),
  });

  app.post("/purchase/verify", {
    schema: { body: verifyPurchaseSchema },
  }, async (request, reply) => {
    const { paymentId, subscriptionId, signature } = request.body as z.infer<typeof verifyPurchaseSchema>;
    const { getRazorpay } = await import("../../lib/razorpay");

    // Validate signature
    const crypto = await import("crypto");
    const config = await import("../../config").then(m => m.loadConfig());

    const expectedSignature = crypto.default
      .createHmac("sha256", config.RAZORPAY_KEY_SECRET)
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
          { subscriptionId },
          { razorpayOrderId: subscriptionId }
        ],
        status: "PENDING"
      }
    });

    if (!transaction) {
      // Check if already success?
      const existing = await prisma.transaction.findFirst({
        where: {
          OR: [
            { subscriptionId },
            { razorpayOrderId: subscriptionId }
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

    try {
      const sub = await razorpay.subscriptions.fetch(subscriptionId);
      if (sub.current_start && sub.current_end) {
        startsAt = new Date(sub.current_start * 1000);
        endsAt = new Date(sub.current_end * 1000);
      } else {
        // Fallback if not active yet (should be active after payment)
        // or calculate from plan
        const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
        if (plan) {
          endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
        }
      }
    } catch (e) {
      request.log.error(e, "Failed to fetch subscription details");
      // Fallback
      const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
      if (plan) {
        endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
      }
    }

    await prisma.userSubscription.create({
      data: {
        userId: transaction.userId,
        planId: transaction.planId,
        status: "ACTIVE",
        razorpayOrderId: subscriptionId, // This in UserSubscription table might still need to be subscriptionId. 
        // Checking schema for UserSubscription... it has razorpayOrderId. 
        // If the user meant "Don't use orderId field in db" generally, I should probably check UserSubscription too.
        // But for now, I'll stick to Transaction adjustments or use subscriptionId if available.
        // However, UserSubscription model ALSO has razorpayOrderId. 
        // I will just put subscriptionId there as it was before, unless instructed otherwise.
        transactionId: transaction.id,
        startsAt,
        endsAt
      }
    });

    return reply.send({
      success: true,
      statusCode: 200,
      userMessage: "Payment verified successfully",
      developerMessage: "Payment verified and subscription activated",
      data: { status: "active" }
    });
  });
}
