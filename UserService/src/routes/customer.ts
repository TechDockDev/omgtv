
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CustomerService } from "../services/customer-service";

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
            const details = await service.getCustomerDetails(userId);

            if (!details) {
                return reply.code(404).send({ message: "Customer profile not found" });
            }

            return {
                success: true,
                data: details
            };
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
}
