import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendCustomerOtp, verifyCustomerOtp, OtpError } from "../services/otp";
import { loadConfig } from "../config";

const otpSendBodySchema = z.object({
    phone: z.string().min(1),
});

const otpVerifyBodySchema = z.object({
    phone: z.string().min(1),
    code: z.string().min(1),
});

export default async function internalOtpRoutes(fastify: FastifyInstance) {
    const config = loadConfig();

    const guardServiceToken = async (request: any, reply: any) => {
        if (!config.SERVICE_AUTH_TOKEN) return;
        const token = (request.headers["x-service-token"] as string) ?? "";
        if (token !== config.SERVICE_AUTH_TOKEN) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
    };

    // Decoupled OTP primitives for other services to use for security actions
    // (e.g. UserService's parental-PIN set/change) — unlike the customer-facing
    // /otp/verify route, these never log anyone in, they just verify a phone.
    fastify.post<{ Body: z.infer<typeof otpSendBodySchema> }>("/internal/otp/send", {
        schema: { body: otpSendBodySchema },
        preHandler: [guardServiceToken],
        handler: async (request, reply) => {
            const body = otpSendBodySchema.parse(request.body);
            try {
                const result = await sendCustomerOtp({
                    prisma: request.server.prisma,
                    redis: request.server.redis,
                    phone: body.phone,
                    ip: request.ip,
                });
                return reply.send({ expiresIn: result.expiresIn });
            } catch (error) {
                if (error instanceof OtpError) {
                    return reply.code(400).send({ code: error.code, message: error.message });
                }
                request.log.error({ err: error }, "Internal OTP send failed");
                throw fastify.httpErrors.internalServerError();
            }
        },
    });

    fastify.post<{ Body: z.infer<typeof otpVerifyBodySchema> }>("/internal/otp/verify", {
        schema: { body: otpVerifyBodySchema },
        preHandler: [guardServiceToken],
        handler: async (request, reply) => {
            const body = otpVerifyBodySchema.parse(request.body);
            try {
                await verifyCustomerOtp({
                    prisma: request.server.prisma,
                    redis: request.server.redis,
                    phone: body.phone,
                    code: body.code,
                    ip: request.ip,
                });
                return reply.send({ verified: true });
            } catch (error) {
                if (error instanceof OtpError) {
                    return reply.code(400).send({ code: error.code, message: error.message });
                }
                request.log.error({ err: error }, "Internal OTP verify failed");
                throw fastify.httpErrors.internalServerError();
            }
        },
    });
}
