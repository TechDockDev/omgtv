import { FastifyInstance } from "fastify";
import { z } from "zod";
import { CustomerService } from "../services/customer-service";
import { getUserDetails } from "../services/user-management";

export default async function internalRoutes(app: FastifyInstance) {
    /**
     * POST /internal/users/batch
     * Batch fetch user details (name, email, phone) for a list of user IDs.
     * Used by EngagementService to enrich review responses with live user data.
     */
    app.post("/users/batch", {
        schema: {
            body: z.object({
                userIds: z.array(z.string().uuid()).min(1).max(50),
            }),
        },
    }, async (request) => {
        const { userIds } = request.body as { userIds: string[] };

        const uniqueIds = [...new Set(userIds)];
        const results: Record<string, { name: string; email: string | null; phone: string | null }> = {};

        await Promise.all(
            uniqueIds.map(async (id) => {
                try {
                    const user = await getUserDetails(request.server.prisma, id);
                    if (user) {
                        results[id] = {
                            name: user.name,
                            email: user.email,
                            phone: user.phone,
                        };
                    }
                } catch (err) {
                    request.log.warn({ err, userId: id }, "Failed to fetch user details in batch");
                }
            })
        );

        return { users: results };
    });
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

    app.post("/users/search", {
        schema: {
            body: z.object({
                filters: z.object({
                    platform: z.enum(["ios", "android", "web"]).optional(),
                    createdAtStart: z.string().datetime().optional(),
                    createdAtEnd: z.string().datetime().optional(),
                }).optional(),
                limit: z.number().default(100),
                offset: z.number().default(0),
            }),
        },
    }, async (request) => {
        const { filters, limit, offset } = request.body as any;
        const where: any = {};

        if (filters?.createdAtStart || filters?.createdAtEnd) {
            where.createdAt = {};
            if (filters.createdAtStart) where.createdAt.gte = new Date(filters.createdAtStart);
            if (filters.createdAtEnd) where.createdAt.lte = new Date(filters.createdAtEnd);
        }

        const users = await app.prisma.customerProfile.findMany({
            where,
            select: { id: true },
            take: limit,
            skip: offset,
        });

        return { userIds: users.map(u => u.id) };
    });

    /**
     * POST /internal/users/fcm-tokens
     * Return FCM tokens for a list of customer profile IDs.
     * Used by NotificationService to resolve push tokens during campaign execution.
     */
    app.post("/users/fcm-tokens", {
        schema: {
            body: z.object({
                userIds: z.array(z.string().uuid()).min(1).max(1000),
            }),
        },
    }, async (request) => {
        const { userIds } = request.body as { userIds: string[] };

        const links = await app.prisma.customerDeviceLink.findMany({
            where: { customerId: { in: userIds } },
            include: {
                device: {
                    select: {
                        deviceId: true,
                        fcmToken: true,
                    },
                },
            },
        });

        const tokens = links
            .filter(link => link.device.fcmToken)
            .map(link => ({
                userId: link.customerId,
                fcmToken: link.device.fcmToken!,
                deviceId: link.device.deviceId,
            }));

        return { tokens };
    });

    /**
     * POST /internal/users/profiles
     * Return detailed profiles for a list of customer profile IDs.
     */
    app.post("/users/profiles", {
        schema: {
            body: z.object({
                userIds: z.array(z.string().uuid()).min(1).max(1000),
            }),
        },
    }, async (request) => {
        const { userIds } = request.body as { userIds: string[] };
        const customerService = new CustomerService(app.prisma);
        const profiles = await customerService.getBatchProfiles(userIds);
        return { profiles };
    });
}
