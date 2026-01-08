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
    return prisma.subscriptionPlan.findMany({ where: { isActive: true } });
  });

  app.get("/me/subscription", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    return prisma.userSubscription.findFirst({
      where: { userId },
      orderBy: { startsAt: "desc" },
      include: { plan: true },
    });
  });

  app.get("/me/transactions", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    return prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  app.post("/purchase/intent", {
    schema: { body: purchaseIntentSchema },
  }, async (request, reply) => {
    const { userId, planId, deviceId } = request.body as z.infer<typeof purchaseIntentSchema>;
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) {
      return reply.notFound("Plan not found or inactive");
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId,
        planId,
        amountPaise: plan.pricePaise,
        currency: plan.currency,
        metadata: deviceId ? { deviceId } : undefined,
      },
    });

    return reply.code(201).send({
      transactionId: transaction.id,
      razorpayOrderId: transaction.razorpayOrderId,
      amountPaise: transaction.amountPaise,
      currency: transaction.currency,
    });
  });
}
