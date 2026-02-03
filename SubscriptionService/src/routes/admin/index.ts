import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";
import { getRazorpay } from "../../lib/razorpay";

const planBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  pricePaise: z.number().int().nonnegative(),
  currency: z.string().default("INR"),
  durationDays: z.number().int().positive(),
  reelsLimit: z.number().int().nonnegative().optional(),
  episodesLimit: z.number().int().nonnegative().optional(),
  seriesLimit: z.number().int().nonnegative().optional(),
  accessLevel: z.string().optional(),
  isUnlimitedReels: z.boolean().default(false),
  isUnlimitedEpisodes: z.boolean().default(false),
  isUnlimitedSeries: z.boolean().default(false),
  isActive: z.boolean().default(true),
  // New UI fields
  features: z.array(z.string()).default([]),
  isPopular: z.boolean().default(false),
  subscriberCount: z.number().int().nonnegative().default(0),
  icon: z.string().optional(),
  savings: z.number().int().nonnegative().default(0),
});

const planUpdateSchema = planBodySchema.partial();
const freePlanSchema = z.object({
  maxFreeReels: z.number().int().nonnegative(),
  maxFreeEpisodes: z.number().int().nonnegative(),
  maxFreeSeries: z.number().int().nonnegative(),
  adminId: z.string().uuid().optional(),
});

type PlanBody = z.infer<typeof planBodySchema>;
type PlanUpdateBody = z.infer<typeof planUpdateSchema>;
type FreePlanBody = z.infer<typeof freePlanSchema>;

export default async function adminRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.post<{ Body: PlanBody }>(
    "/plans",
    {
      schema: {
        body: planBodySchema,
      },
    },
    async (request, reply) => {
      const body = planBodySchema.parse(request.body);

      const razorpay = getRazorpay();

      // Calculate period and interval
      // Simple logic: treat as monthly if multiple of 30, else daily
      let period: "daily" | "weekly" | "monthly" | "yearly" = "daily";
      let interval = body.durationDays;

      if (body.durationDays % 365 === 0) {
        period = "yearly";
        interval = body.durationDays / 365;
      } else if (body.durationDays % 30 === 0) {
        period = "monthly";
        interval = body.durationDays / 30;
      }

      let razorpayPlanId: string | undefined;

      try {
        const rzpPlan = await razorpay.plans.create({
          period,
          interval,
          item: {
            name: body.name,
            amount: body.pricePaise, // amount in smallest currency unit
            currency: body.currency,
            description: body.description || "Subscription Plan",
          },
        });
        razorpayPlanId = rzpPlan.id;
      } catch (error) {
        request.log.error(error, "Failed to create Razorpay plan");
        // Fail if Razorpay creation fails to maintain consistency
        return reply.status(502).send({ message: "Failed to create plan on Razorpay", error });
      }

      const plan = await prisma.subscriptionPlan.create({
        data: {
          ...body,
          razorpayPlanId
        },
      });
      return reply.code(201).send({
        success: true,
        statusCode: 201,
        userMessage: "Plan created successfully",
        developerMessage: "Subscription plan created",
        data: plan,
      });
    }
  );

  app.get("/plans", async () => {
    const data = await prisma.subscriptionPlan.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return {
      success: true,
      statusCode: 200,
      userMessage: "Plans retrieved successfully",
      developerMessage: "Admin plans retrieved",
      data,
    };
  });

  app.put<{ Params: { id: string }; Body: PlanUpdateBody }>(
    "/plans/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: planUpdateSchema,
      },
    },
    async (request, reply) => {
      const body = planUpdateSchema.parse(request.body);
      const { id } = request.params;

      const existingPlan = await prisma.subscriptionPlan.findUnique({
        where: { id },
      });

      if (!existingPlan) {
        return reply.status(404).send({ message: "Plan not found" });
      }

      let razorpayPlanId = existingPlan.razorpayPlanId;

      // Check if critical fields for Razorpay are changing
      const isPriceChanging =
        body.pricePaise !== undefined && body.pricePaise !== existingPlan.pricePaise;

      if (isPriceChanging) {
        const newPrice = body.pricePaise!;

        if (newPrice === 0) {
          // If price becomes 0, remove Razorpay association
          razorpayPlanId = null;
        } else {
          // If price is > 0, create a new Razorpay plan
          // Need to use new duration if provided, else existing
          const durationDays = body.durationDays ?? existingPlan.durationDays;
          const name = body.name ?? existingPlan.name;
          const description = body.description ?? existingPlan.description;
          const currency = body.currency ?? existingPlan.currency;

          // Recalculate period/interval
          let period: "daily" | "weekly" | "monthly" | "yearly" = "daily";
          let interval = durationDays;

          if (durationDays % 365 === 0) {
            period = "yearly";
            interval = durationDays / 365;
          } else if (durationDays % 30 === 0) {
            period = "monthly";
            interval = durationDays / 30;
          }

          const razorpay = getRazorpay();
          try {
            const rzpPlan = await razorpay.plans.create({
              period,
              interval,
              item: {
                name,
                amount: newPrice,
                currency,
                description: description || "Subscription Plan",
              },
            });
            razorpayPlanId = rzpPlan.id;
          } catch (error) {
            request.log.error(error, "Failed to create new Razorpay plan during update");
            return reply
              .status(502)
              .send({ message: "Failed to create plan on Razorpay", error });
          }
        }
      }

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: {
          ...body,
          razorpayPlanId,
        },
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: "Plan updated successfully",
        developerMessage: "Subscription plan updated",
        data: updatedPlan,
      };
    }
  );

  app.delete(
    "/plans/:id",
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const data = await prisma.subscriptionPlan.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      return {
        success: true,
        statusCode: 0,
        userMessage: "Plan deleted successfully",
        developerMessage: "Plan soft-deleted successfully",
        data,
      };
    }
  );

  const planStatusSchema = z.object({
    isActive: z.boolean(),
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof planStatusSchema> }>(
    "/plans/:id/status",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: planStatusSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { isActive } = planStatusSchema.parse(request.body);

      const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
      if (!plan) {
        return reply.status(404).send({ message: "Plan not found" });
      }

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: { isActive },
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: "Plan status updated successfully",
        developerMessage: "Plan activity status changed",
        data: updatedPlan,
      };
    }
  );



  const trialPlanBodySchema = z.object({
    trialPricePaise: z.number().int().nonnegative(),
    durationDays: z.number().int().positive(),
    reminderDays: z.number().int().nonnegative(),
    isAutoDebit: z.boolean().default(true),
    isActive: z.boolean().default(true),
  });
  const trialPlanUpdateSchema = trialPlanBodySchema.partial();

  app.post<{ Body: z.infer<typeof trialPlanBodySchema> }>(
    "/custom-trials",
    {
      schema: { body: trialPlanBodySchema },
    },
    async (request, reply) => {
      const body = trialPlanBodySchema.parse(request.body);

      if (body.isActive) {
        const existingActive = await prisma.trialPlan.findFirst({
          where: { isActive: true }
        });
        if (existingActive) {
          return reply.badRequest("An active trial plan already exists. Please modify the existing one or deactivate it first.");
        }
      }



      const trialPlan = await prisma.trialPlan.create({ data: body });
      return reply.code(201).send({
        success: true,
        statusCode: 0,
        userMessage: "Trial plan created successfully",
        developerMessage: "Trial plan created successfully",
        data: trialPlan,
      });
    }
  );


  app.get(
    "/stats",
    async (_request, reply) => {
      const [revenueAgg, trialUsers, totalSubscribers] = await Promise.all([
        // 1. Total Revenue
        prisma.transaction.aggregate({
          _sum: { amountPaise: true },
          where: { status: "SUCCESS" },
        }),
        // 2. Conversion Rate Base (Total uniquely ever on trial)
        prisma.userSubscription.findMany({
          where: { trialPlanId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
        }),
        // 3. Total Subscribers (Active Paid Users)
        prisma.userSubscription.count({
          where: { status: "ACTIVE", trialPlanId: null },
        }),
      ]);

      const totalRevenue = revenueAgg._sum.amountPaise || 0;
      const trialUserIds = trialUsers.map((u) => u.userId);

      let conversionRate = 0;
      let convertedCount = 0;

      if (trialUserIds.length > 0) {
        // Find how many of these users have bought a regular plan
        // A regular plan transaction must NOT have a trialPlanId
        const convertedUsers = await prisma.transaction.findMany({
          where: {
            userId: { in: trialUserIds },
            planId: { not: null },
            trialPlanId: null, // Crucial: Ensure this is not a trial purchase
            status: "SUCCESS",
          },
          select: { userId: true },
          distinct: ["userId"],
        });
        convertedCount = convertedUsers.length;
        conversionRate = (convertedCount / trialUserIds.length) * 100;
      }

      return {
        success: true,
        statusCode: 200,
        userMessage: "Stats retrieved successfully",
        developerMessage: "Transaction stats including revenue, conversion rate, subscribers, and trials",
        data: {
          totalRevenue,
          conversionRate,
          trialUsersCount: trialUserIds.length,
          convertedUsersCount: convertedCount,
          totalSubscribers,
        },
      };
    }
  );

  app.get<{ Querystring: { page?: number; limit?: number } }>(
    "/trial-users",
    {
      schema: {
        querystring: z.object({
          page: z.coerce.number().min(1).default(1),
          limit: z.coerce.number().min(1).max(100).default(10),
        }),
      },
    },
    async (request) => {
      const { page = 1, limit = 10 } = request.query;
      const skip = (page - 1) * limit;

      const [total, data] = await Promise.all([
        prisma.userSubscription.count({
          where: { trialPlanId: { not: null } },
        }),
        prisma.userSubscription.findMany({
          where: { trialPlanId: { not: null } },
          include: {
            trialPlan: true,
            plan: true,
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      return {
        success: true,
        statusCode: 200,
        userMessage: "Trial users retrieved successfully",
        developerMessage: "Paginated list of trial users",
        data: {
          items: data.map(sub => ({
            id: sub.id,
            userId: sub.userId,
            trialPlanId: sub.trialPlanId,
            status: sub.status,
            startsAt: sub.startsAt,
            endsAt: sub.endsAt,
            // Include flattened trial plan info if needed, or just omit based on request
            // User specifically asked to remove certain fields, assuming they just want the list of users
          })),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
      };
    }
  );

  app.get("/custom-trials", async () => {
    const data = await prisma.trialPlan.findMany({
      orderBy: { createdAt: "desc" },
    });
    return {
      success: true,
      statusCode: 0,
      userMessage: "Trial plans retrieved successfully",
      developerMessage: "Trial plans retrieved successfully",
      data,
    };
  });

  app.put<{ Params: { id: string }; Body: z.infer<typeof trialPlanUpdateSchema> }>(
    "/custom-trials/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: trialPlanUpdateSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = trialPlanUpdateSchema.parse(request.body);

      const existing = await prisma.trialPlan.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ message: "Trial plan not found" });
      }

      if (body.isActive === true) {
        // If attempting to activate, check if another one is already active (excluding self)
        const existingActive = await prisma.trialPlan.findFirst({
          where: {
            isActive: true,
            id: { not: id }
          }
        });
        if (existingActive) {
          return reply.badRequest("Another trial plan is already active. Only one active trial plan is allowed.");
        }
      }




      const updated = await prisma.trialPlan.update({
        where: { id },
        data: body,
      });
      return {
        success: true,
        statusCode: 0,
        userMessage: "Trial plan updated successfully",
        developerMessage: "Trial plan updated successfully",
        data: updated,
      };
    }
  );

  const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10),
  });

  app.get(
    "/transactions",
    {
      schema: { querystring: paginationSchema },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationSchema>;
      const skip = (page - 1) * limit;

      const [total, data] = await Promise.all([
        prisma.transaction.count(),
        prisma.transaction.findMany({
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      return {
        success: true,
        statusCode: 200,
        userMessage: "Transactions retrieved successfully",
        developerMessage: "Transactions retrieved with pagination",
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    }
  );

  app.get(
    "/users/:userId/subscription",
    {
      schema: { params: z.object({ userId: z.string() }) },
    },
    async (request) => {
      const { userId } = request.params as { userId: string };
      const data = await prisma.userSubscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { plan: true, transaction: true },
      });
      return {
        success: true,
        statusCode: 200,
        userMessage: "User subscription retrieved successfully",
        developerMessage: "Admin user subscription details",
        data,
      };
    }
  );


}
