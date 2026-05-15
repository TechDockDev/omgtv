import type { FastifyInstance } from "fastify";
import { generalSettingSchema, generalSettingResponseSchema, type GeneralSettingBody } from "../schemas/settings";
import { authenticateAdmin } from "../utils/auth";
import fp from "fastify-plugin";
import { OtpEvent, AuthProvider } from "@prisma/client";
import { z } from "zod";

export default fp(async function adminSettingsRoutes(fastify: FastifyInstance) {
    fastify.get("/general-settings", {
        schema: {
            response: {
                200: generalSettingResponseSchema,
            },
        },
        preHandler: [authenticateAdmin],
        handler: async (request, reply) => {
            const prisma = request.server.prisma;
            let settings = await prisma.generalSetting.findUnique({
                where: { id: 1 },
            });

            if (!settings) {
                settings = await prisma.generalSetting.create({
                    data: { id: 1 },
                });
            }

            return {
                success: true,
                statusCode: 0,
                userMessage: "Settings retrieved successfully",
                developerMessage: "Settings retrieved successfully",
                data: settings,
            };
        },
    });


    fastify.post<{ Body: GeneralSettingBody }>(
        "/general-settings",
        {
            schema: {
                body: generalSettingSchema,
                response: {
                    200: generalSettingResponseSchema,
                },
            },
            preHandler: [authenticateAdmin],
        },
        async (request, reply) => {
            const prisma = request.server.prisma;
            const body = generalSettingSchema.parse(request.body);

            const settings = await prisma.generalSetting.upsert({
                where: { id: 1 },
                update: {
                    ...body,
                    updatedAt: new Date(),
                },
                create: {
                    id: 1,
                    ...body,
                },
            });

            return {
                success: true,
                statusCode: 0,
                userMessage: "Settings saved successfully",
                developerMessage: "Settings saved successfully",
                data: settings,
            };
        }
    );

    // OTP funnel analytics
    fastify.get("/analytics/otp", {
        preHandler: [authenticateAdmin],
        handler: async (request) => {
            const prisma = request.server.prisma;
            const query = request.query as { from?: string; to?: string; phone?: string };

            const from = query.from ? new Date(query.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const to = query.to ? new Date(query.to) : new Date();
            const phoneFilter = query.phone ? { phone: query.phone } : {};

            const [counts, perDay] = await Promise.all([
                prisma.otpLog.groupBy({
                    by: ["event"],
                    where: { createdAt: { gte: from, lte: to }, ...phoneFilter },
                    _count: { event: true },
                }),
                prisma.otpLog.groupBy({
                    by: ["event", "createdAt"],
                    where: {
                        createdAt: { gte: from, lte: to },
                        ...phoneFilter,
                        event: { in: [OtpEvent.SEND_REQUESTED, OtpEvent.VERIFY_SUCCESS, OtpEvent.VERIFY_FAILED] },
                    },
                    _count: { event: true },
                    orderBy: { createdAt: "asc" },
                }),
            ]);

            const funnel = Object.fromEntries(
                Object.values(OtpEvent).map((e) => [
                    e,
                    counts.find((c) => c.event === e)?._count.event ?? 0,
                ])
            );

            const sent = funnel[OtpEvent.SEND_REQUESTED] || 0;
            const success = funnel[OtpEvent.VERIFY_SUCCESS] || 0;
            const conversionRate = sent > 0 ? `${((success / sent) * 100).toFixed(1)}%` : "0%";

            return {
                success: true,
                statusCode: 0,
                userMessage: "OTP analytics retrieved",
                data: { funnel, conversionRate, perDay },
            };
        },
    });

    // Per-phone drill-down
    fastify.get("/analytics/otp/phone/:phone", {
        preHandler: [authenticateAdmin],
        handler: async (request) => {
            const prisma = request.server.prisma;
            const { phone } = request.params as { phone: string };

            const logs = await prisma.otpLog.findMany({
                where: { phone: decodeURIComponent(phone) },
                orderBy: { createdAt: "desc" },
                take: 100,
                select: {
                    id: true,
                    event: true,
                    dltRequestId: true,
                    errorMessage: true,
                    attemptCount: true,
                    ip: true,
                    deviceId: true,
                    appVersion: true,
                    createdAt: true,
                },
            });

            return {
                success: true,
                statusCode: 0,
                userMessage: "OTP logs retrieved",
                data: { phone: decodeURIComponent(phone), logs },
            };
        },
    });

    // Auth provider breakdown — how many users registered via Firebase vs DLT
    fastify.get("/analytics/auth-providers", {
        preHandler: [authenticateAdmin],
        handler: async (request) => {
            const prisma = request.server.prisma;

            const [providerCounts, recentRegistrations] = await Promise.all([
                prisma.customerIdentity.groupBy({
                    by: ["authProvider"],
                    _count: { authProvider: true },
                }),
                prisma.customerIdentity.groupBy({
                    by: ["authProvider"],
                    where: {
                        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
                    },
                    _count: { authProvider: true },
                }),
            ]);

            const total = providerCounts.reduce((sum, r) => sum + r._count.authProvider, 0);

            const breakdown = Object.values(AuthProvider).map((provider) => {
                const all = providerCounts.find((r) => r.authProvider === provider)?._count.authProvider ?? 0;
                const last30d = recentRegistrations.find((r) => r.authProvider === provider)?._count.authProvider ?? 0;
                return {
                    provider,
                    total: all,
                    last30Days: last30d,
                    percentage: total > 0 ? `${((all / total) * 100).toFixed(1)}%` : "0%",
                };
            });

            return {
                success: true,
                statusCode: 0,
                userMessage: "Auth provider analytics retrieved",
                data: { totalCustomers: total, breakdown },
            };
        },
    });
});
