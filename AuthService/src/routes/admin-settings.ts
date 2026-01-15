import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { generalSettingSchema, generalSettingResponseSchema, type GeneralSettingBody } from "../schemas/settings";

export default fp(async function adminSettingsRoutes(fastify: FastifyInstance) {
    fastify.get("/general-settings", {
        schema: {
            response: {
                200: generalSettingResponseSchema,
            },
        },
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
});
