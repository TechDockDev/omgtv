import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";

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
      const plan = await prisma.subscriptionPlan.create({
        data: body,
      });
      return reply.code(201).send(plan);
    }
  );

  app.get("/plans", async () => {
    return prisma.subscriptionPlan.findMany({ orderBy: { createdAt: "desc" } });
  });

  app.put<{ Params: { id: string }; Body: PlanUpdateBody }>(
    "/plans/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: planUpdateSchema,
      },
    },
    async (request) => {
      const body = planUpdateSchema.parse(request.body);
      const { id } = request.params;
      return prisma.subscriptionPlan.update({ where: { id }, data: body });
    }
  );

  app.delete(
    "/plans/:id",
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return prisma.subscriptionPlan.update({
        where: { id },
        data: { isActive: false },
      });
    }
  );

  app.put<{ Body: FreePlanBody }>(
    "/free-plan",
    {
      schema: { body: freePlanSchema },
    },
    async (request) => {
      const { adminId, ...limits } = freePlanSchema.parse(request.body);
      return prisma.freePlanConfig.upsert({
        where: { id: 1 },
        update: { ...limits, updatedByAdminId: adminId },
        create: { id: 1, ...limits, updatedByAdminId: adminId },
      });
    }
  );

  app.get("/transactions", async () => {
    return prisma.transaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.get(
    "/users/:userId/subscription",
    {
      schema: { params: z.object({ userId: z.string() }) },
    },
    async (request) => {
      const { userId } = request.params as { userId: string };
      return prisma.userSubscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { plan: true, transaction: true },
      });
    }
  );
}
