import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";

const purchaseIntentSchema = z.object({
  planId: z.string().uuid(),
  deviceId: z.string().optional(),
  isTrial: z.boolean().optional(),
});

export default async function customerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get("/plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (request) => {
    const { userId } = request.query as { userId?: string };

    // Check if user has already used a trial
    let hasUsedTrial = false;
    if (userId) {
      const trialSub = await prisma.userSubscription.findFirst({
        where: { userId, trialPlanId: { not: null } }
      });
      hasUsedTrial = !!trialSub;
    }

    // Fetch global trial plan (not tied to any specific plan)
    const globalTrialPlan = await prisma.trialPlan.findFirst({
      where: { isActive: true }
    });

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
      trialPlan: (globalTrialPlan && !hasUsedTrial) ? {
        id: globalTrialPlan.id,
        trialPricePaise: globalTrialPlan.trialPricePaise,
        durationDays: globalTrialPlan.durationDays,
        isAutoDebit: globalTrialPlan.isAutoDebit,
        isEligible: true
      } : null,
      data: formattedPlans,
    };
  });

  app.get("/trial-plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (request) => {
    const { userId } = request.query as { userId?: string };

    // Check if user has already used a trial
    let hasUsedTrial = false;
    if (userId) {
      const trialSub = await prisma.userSubscription.findFirst({
        where: { userId, trialPlanId: { not: null } }
      });
      hasUsedTrial = !!trialSub;
    }

    if (hasUsedTrial) {
      return {
        success: true,
        statusCode: 200,
        userMessage: "Trial plans retrieved successfully",
        developerMessage: "User has already used a trial, returning empty list",
        data: [],
      };
    }

    const trialPlans = await prisma.trialPlan.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    const formattedTrialPlans = trialPlans.map(tp => ({
      id: tp.id,
      trialPricePaise: tp.trialPricePaise,
      durationDays: tp.durationDays,
      reminderDays: tp.reminderDays,
      isAutoDebit: tp.isAutoDebit,
      isEligible: true
    }));

    return {
      success: true,
      statusCode: 200,
      userMessage: "Trial plans retrieved successfully",
      developerMessage: "Active trial plans retrieved",
      data: formattedTrialPlans,
    };
  });


  app.get("/me/subscription", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    const subscription = await prisma.userSubscription.findFirst({
      where: { userId },
      orderBy: { startsAt: "desc" },
      include: {
        plan: true,
        trialPlan: true
      },
    });

    // If user has a trial, return trial details instead of main plan
    const data = subscription ? {
      ...subscription,
      // During trial period, show trial plan information
      displayPlan: subscription.trialPlan || subscription.plan
    } : null;

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
    const { planId, deviceId, isTrial } = request.body as z.infer<typeof purchaseIntentSchema>;
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

    let plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
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

      // One trial per user check
      const existingTrial = await prisma.userSubscription.findFirst({
        where: {
          userId,
          trialPlanId: { not: null }
        }
      });

      if (existingTrial) {
        // User has already used a trial. 
        // Fallback to standard plan: ensure plan is set, then disable trial.
        // Fallback to standard plan: ensure plan is set, then disable trial.
        trialPlan = null;
      }
      // If eligible, we simply proceed with both plan (target) and trialPlan set.

    }

    if (!plan || !plan.isActive) {
      return reply.notFound("Plan not found or inactive");
    }

    if (!plan.razorpayPlanId) {
      return reply.badRequest("Plan is not configured for online payments (missing Razorpay Plan ID)");
    }

    const { getRazorpay } = await import("../../lib/razorpay");
    const razorpay = getRazorpay();

    try {
      const subscriptionOptions: any = {
        plan_id: plan.razorpayPlanId,
        customer_notify: 1,
        total_count: 120, // Default to 10 years (120 months) for auto-renew
        quantity: 1,
        notes: {
          userId,
          planId: trialPlan ? trialPlan.id : plan.id,
          internalPlanId: plan.id, // The actual subscription plan ID
          isTrial: !!trialPlan
        }
      };

      if (trialPlan) {
        // Start the paid subscription after the trial duration
        // Current time + trial days * 24h * 60m * 60s
        const startAt = Math.floor(Date.now() / 1000) + (trialPlan.durationDays * 24 * 60 * 60);
        subscriptionOptions.start_at = startAt;

        // Provide immediate access via trial
        // If there is a trial price, we add it as an upfront charge (addon)
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
          planId: plan.id, // Link to the target plan (SubscriptionPlan)
          amountPaise: trialPlan ? trialPlan.trialPricePaise : plan.pricePaise,
          currency: plan.currency,
          subscriptionId: subscription.id,
          razorpayPlanId: plan.razorpayPlanId, // Storing the Razorpay Plan ID for reference
          trialPlanId: trialPlan ? trialPlan.id : null,
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

    // Extract trialPlanId from metadata if available
    const metadata = transaction.metadata as Record<string, any> | null;
    const trialPlanId = metadata?.trialPlanId;

    await prisma.userSubscription.create({
      data: {
        userId: transaction.userId,
        planId: transaction.planId,
        trialPlanId: trialPlanId, // Link the trial plan if this was a trial purchase
        status: "ACTIVE",
        razorpayOrderId: subscriptionId,
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
