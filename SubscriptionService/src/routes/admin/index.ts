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
    targetPlanId: z.string().uuid(),
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
      const targetPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: body.targetPlanId },
      });
      if (!targetPlan) {
        return reply.status(404).send({ message: "Target plan not found" });
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

  app.get("/custom-trials", async () => {
    const data = await prisma.trialPlan.findMany({
      orderBy: { createdAt: "desc" },
      include: { targetPlan: true },
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

      if (body.targetPlanId) {
        const targetPlan = await prisma.subscriptionPlan.findUnique({
          where: { id: body.targetPlanId }
        });
        if (!targetPlan) return reply.status(404).send({ message: "Target plan not found" });
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
