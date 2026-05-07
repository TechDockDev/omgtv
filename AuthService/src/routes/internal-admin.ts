import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthSubjectType } from "@prisma/client";
import { hashPassword } from "../utils/password";
import { loadConfig } from "../config";
import { AuthError } from "../services/auth";

const provisionSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().optional(),
});

const deactivateSchema = z.object({
    isActive: z.boolean(),
});

export default fp(async function internalAdminRoutes(fastify: FastifyInstance) {
    const config = loadConfig();

    const guardServiceToken = async (request: any, reply: any) => {
        if (!config.SERVICE_AUTH_TOKEN) return;
        const token = (request.headers["x-service-token"] as string) ?? "";
        if (token !== config.SERVICE_AUTH_TOKEN) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
    };

    /**
     * POST /internal/admin/provision
     * Create an admin credential and return { subjectId, email }.
     * Called by UserService Permission Center when creating a new admin account.
     */
    fastify.post("/internal/admin/provision", {
        preHandler: [guardServiceToken],
    }, async (request, reply) => {
        const body = provisionSchema.parse(request.body);
        const email = body.email.toLowerCase().trim();
        const prisma = request.server.prisma;

        const existing = await prisma.adminCredential.findUnique({ where: { email } });
        if (existing) {
            return reply.code(409).send({ error: "Admin email already exists" });
        }

        const passwordHash = await hashPassword(body.password);

        const subject = await prisma.authSubject.create({
            data: {
                type: AuthSubjectType.ADMIN,
                admin: {
                    create: {
                        email,
                        passwordHash,
                        isActive: true,
                    },
                },
            },
            include: { admin: true },
        });

        return reply.code(201).send({ subjectId: subject.id, email });
    });

    /**
     * PATCH /internal/admin/:subjectId/active
     * Activate or deactivate an admin credential.
     */
    fastify.patch("/internal/admin/:subjectId/active", {
        preHandler: [guardServiceToken],
    }, async (request, reply) => {
        const { subjectId } = request.params as { subjectId: string };
        const { isActive } = deactivateSchema.parse(request.body);
        const prisma = request.server.prisma;

        const credential = await prisma.adminCredential.findFirst({
            where: { subjectId },
        });
        if (!credential) {
            return reply.code(404).send({ error: "Admin not found" });
        }

        await prisma.adminCredential.update({
            where: { subjectId },
            data: { isActive },
        });

        return { success: true };
    });

    /**
     * POST /internal/admin/:subjectId/reset-password
     * Reset admin password.
     */
    fastify.post("/internal/admin/:subjectId/reset-password", {
        preHandler: [guardServiceToken],
    }, async (request, reply) => {
        const { subjectId } = request.params as { subjectId: string };
        const { password } = z.object({ password: z.string().min(6) }).parse(request.body);
        const prisma = request.server.prisma;

        const credential = await prisma.adminCredential.findFirst({ where: { subjectId } });
        if (!credential) {
            return reply.code(404).send({ error: "Admin not found" });
        }

        const passwordHash = await hashPassword(password);
        await prisma.adminCredential.update({
            where: { subjectId },
            data: { passwordHash, passwordUpdatedAt: new Date() },
        });

        return { success: true };
    });
});
