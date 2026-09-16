
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CustomerService, PinError } from "../services/customer-service";

const detailsBodySchema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
});

const detailsResponseSchema = z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    isProfileComplete: z.boolean(),
});

export default async function customerRoutes(fastify: FastifyInstance) {
    const service = new CustomerService(fastify.prisma);

    fastify.get("/details", {
        schema: {
            response: {
                200: z.object({
                    success: z.boolean(),
                    data: detailsResponseSchema
                })
            }
        },
        preHandler: [async (req, reply) => {
            const userId = req.headers["x-user-id"];
            if (!userId || typeof userId !== 'string') {
                reply.code(401).send({ message: "Unauthorized" });
                throw new Error("Unauthorized");
            }
        }],
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            try {
                const details = await service.getCustomerDetails(userId);

                if (!details) {
                    return reply.code(404).send({ message: "Customer profile not found" });
                }

                return {
                    success: true,
                    data: details
                };
            } catch (error) {
                req.log.error(error);
                return reply.code(500).send({ message: "Internal server error" });
            }
        },
    });

    fastify.put("/details", {
        schema: {
            body: detailsBodySchema,
            response: {
                200: z.object({
                    success: z.boolean(),
                    message: z.string()
                })
            }
        },
        preHandler: [async (req, reply) => {
            const userId = req.headers["x-user-id"];
            if (!userId || typeof userId !== 'string') {
                reply.code(401).send({ message: "Unauthorized" });
                throw new Error("Unauthorized");
            }
        }],
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            const body = detailsBodySchema.parse(req.body);

            try {
                await service.updateCustomerDetails(userId, body);
                return {
                    success: true,
                    message: "Details updated successfully"
                };
            } catch (error) {
                req.log.error(error);
                return reply.code(500).send({ message: "Failed to update details" });
            }
        },
    });

    // --- Parental PIN ---

    const requireUserId = [async (req: any, reply: any) => {
        const userId = req.headers["x-user-id"];
        if (!userId || typeof userId !== 'string') {
            reply.code(401).send({ message: "Unauthorized" });
            throw new Error("Unauthorized");
        }
    }];

    const pinErrorStatus: Record<PinError["code"], number> = {
        NO_PHONE: 400,
        OTP_FAILED: 400,
        NO_PIN: 400,
        LOCKED: 423,
        INVALID_PIN: 401,
    };

    const handlePinError = (error: unknown, reply: any) => {
        if (error instanceof PinError) {
            return reply.code(pinErrorStatus[error.code]).send({ code: error.code, message: error.message });
        }
        throw error;
    };

    fastify.get("/pin/status", {
        preHandler: requireUserId,
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            try {
                const result = await service.getPinStatus(userId);
                return { success: true, data: result };
            } catch (error) {
                return handlePinError(error, reply);
            }
        },
    });

    fastify.post("/pin/otp/send", {
        preHandler: requireUserId,
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            try {
                const result = await service.sendPinOtp(userId);
                return { success: true, data: result };
            } catch (error) {
                return handlePinError(error, reply);
            }
        },
    });

    const setPinBodySchema = z.object({
        pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
        otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
    });

    fastify.put("/pin", {
        schema: { body: setPinBodySchema },
        preHandler: requireUserId,
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            const body = setPinBodySchema.parse(req.body);
            try {
                await service.setPin(userId, body.pin, body.otp);
                return { success: true, message: "PIN saved successfully" };
            } catch (error) {
                return handlePinError(error, reply);
            }
        },
    });

    const verifyPinBodySchema = z.object({
        pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
    });

    fastify.post("/pin/verify", {
        schema: { body: verifyPinBodySchema },
        preHandler: requireUserId,
        handler: async (req, reply) => {
            const userId = req.headers["x-user-id"] as string;
            const body = verifyPinBodySchema.parse(req.body);
            try {
                const result = await service.verifyPin(userId, body.pin);
                return { success: true, data: result };
            } catch (error) {
                return handlePinError(error, reply);
            }
        },
    });
}
