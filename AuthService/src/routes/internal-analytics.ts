import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config";

export default fp(async function internalAnalyticsRoutes(fastify: FastifyInstance) {
  const config = loadConfig();

  const guardServiceToken = async (request: any, reply: any) => {
    if (!config.SERVICE_AUTH_TOKEN) return;
    const token = (request.headers["x-service-token"] as string) ?? "";
    if (token !== config.SERVICE_AUTH_TOKEN) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

  /**
   * GET /internal/analytics/registrations
   * Returns CustomerIdentity rows grouped into cohort buckets by register date.
   * userIds are CustomerIdentity.customerId values (= CustomerProfile.id in UserService
   * = UserSubscription.userId in SubscriptionService).
   */
  fastify.get("/internal/analytics/registrations", {
    preHandler: [guardServiceToken],
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        period: z.enum(["daily", "monthly"]).optional().default("monthly"),
      }),
    },
  }, async (request) => {
    const { startDate, endDate, period = "monthly" } = request.query as {
      startDate?: string;
      endDate?: string;
      period: "daily" | "monthly";
    };

    const start = startDate
      ? new Date(`${startDate}T00:00:00.000+05:30`)
      : new Date("2020-01-01T00:00:00.000Z");
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999+05:30`)
      : new Date();

    const prisma = (request.server as any).prisma;

    const rows: { customerId: string; createdAt: Date }[] = await prisma.customerIdentity.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: { customerId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const cohortMap = new Map<string, string[]>();
    for (const row of rows) {
      const key =
        period === "daily"
          ? row.createdAt.toISOString().slice(0, 10)
          : row.createdAt.toISOString().slice(0, 7);
      if (!cohortMap.has(key)) cohortMap.set(key, []);
      cohortMap.get(key)!.push(row.customerId);
    }

    const cohorts = Array.from(cohortMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, userIds]) => ({ period: p, userIds, count: userIds.length }));

    return { cohorts };
  });

  /**
   * GET /internal/analytics/registration-counts
   * Same as /registrations but returns only {period, count} — no userIds array.
   * Used by SubscriptionService biz-fin endpoint to get cumulative registered users
   * without transferring large UUID arrays.
   */
  fastify.get("/internal/analytics/registration-counts", {
    preHandler: [guardServiceToken],
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        period: z.enum(["daily", "monthly"]).optional().default("monthly"),
      }),
    },
  }, async (request) => {
    const { startDate, endDate, period = "monthly" } = request.query as {
      startDate?: string;
      endDate?: string;
      period: "daily" | "monthly";
    };

    const start = startDate
      ? new Date(`${startDate}T00:00:00.000+05:30`)
      : new Date("2020-01-01T00:00:00.000Z");
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999+05:30`)
      : new Date();

    const prisma = (request.server as any).prisma;

    const rows: { createdAt: Date }[] = await prisma.customerIdentity.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const countMap = new Map<string, number>();
    for (const row of rows) {
      const key =
        period === "daily"
          ? row.createdAt.toISOString().slice(0, 10)
          : row.createdAt.toISOString().slice(0, 7);
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    const cohorts = Array.from(countMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, count]) => ({ period: p, count }));

    return { cohorts };
  });
});
