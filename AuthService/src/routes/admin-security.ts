import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import {
    updatePasswordSchema,
    type UpdatePasswordBody
} from "../schemas/auth";
import { authenticateAdmin } from "../utils/auth";

export default fp(async function adminSecurityRoutes(fastify: FastifyInstance) {

    // POST /api/v1/auth/admin/update-password
    fastify.post<{ Body: UpdatePasswordBody }>("/api/v1/auth/admin/update-password", {
        schema: {
            body: updatePasswordSchema,
        },
        preHandler: [authenticateAdmin],
        handler: async (request, reply) => {
            const { oldPassword, newPassword } = request.body;
            const prisma = request.server.prisma;
            const subjectId = request.user.sub;

            // Find admin
            const admin = await prisma.adminCredential.findUnique({
                where: { subjectId },
            });

            if (!admin) {
                throw fastify.httpErrors.notFound("Admin account not found");
            }

            // Verify old password
            const isValid = await bcrypt.compare(oldPassword, admin.passwordHash);
            if (!isValid) {
                throw fastify.httpErrors.unauthorized("Invalid current password");
            }

            // Hash new password
            const newPasswordHash = await bcrypt.hash(newPassword, 10);

            // Update password
            await prisma.adminCredential.update({
                where: { subjectId },
                data: {
                    passwordHash: newPasswordHash,
                    passwordUpdatedAt: new Date(),
                },
            });

            return { success: true, message: "Password updated successfully." };
        }
    });
});
