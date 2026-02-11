import { FastifyInstance } from "fastify";
import { z } from "zod";

export default async function internalRoutes(app: FastifyInstance) {
    app.get("/stats", {
        schema: {
            querystring: z.object({
                startDate: z.string().optional(),
                endDate: z.string().optional(),
            }),
        },
    }, async (request) => {
        const { startDate, endDate, granularity = "daily" } = request.query as { startDate?: string; endDate?: string; granularity?: string };
        const start = startDate ? new Date(startDate) : new Date(0);
        const end = endDate ? new Date(endDate) : new Date();

        const [newCustomers, newGuests, totalCustomers, totalGuests, trend] = await Promise.all([
            app.prisma.customerProfile.count({
                where: { createdAt: { gte: start, lte: end } },
            }),
            app.prisma.guestProfile.count({
                where: { createdAt: { gte: start, lte: end } },
            }),
            app.prisma.customerProfile.count(),
            app.prisma.guestProfile.count(),
            app.prisma.customerProfile.groupBy({
                by: ["createdAt"],
                where: { createdAt: { gte: start, lte: end } },
                _count: true,
            }),
        ]);

        // Format trend data by requested granularity
        const buckets: Record<string, number> = {};
        trend.forEach(item => {
            let key = item.createdAt.toISOString().split("T")[0]; // default daily
            if (granularity === "monthly") {
                key = item.createdAt.toISOString().substring(0, 7); // YYYY-MM
            } else if (granularity === "yearly") {
                key = item.createdAt.toISOString().substring(0, 4); // YYYY
            }
            buckets[key] = (buckets[key] || 0) + item._count;
        });

        const trendData = Object.entries(buckets).map(([date, value]) => ({
            date,
            value,
        })).sort((a, b) => a.date.localeCompare(b.date));

        return {
            newCustomers,
            newGuests,
            totalCustomers,
            totalGuests,
            trend: trendData,
        };
    });
}
