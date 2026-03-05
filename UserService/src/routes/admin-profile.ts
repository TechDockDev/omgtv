import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { updateAdminProfileSchema, type UpdateAdminProfileBody } from "../schemas/admin-profile";

export default async function adminProfileRoutes(fastify: FastifyInstance) {
    // GET /api/v1/user/admin/profile/me
    fastify.get("/me", {
        handler: async (request, reply) => {
            const prisma = request.server.prisma;
            const subjectId = (request.headers["x-admin-id"] || request.headers["x-user-id"]) as string;

            if (!subjectId) {
                throw fastify.httpErrors.unauthorized("User ID missing in headers");
            }

            let profile = await prisma.adminProfile.findUnique({
                where: { subjectId },
            });

            if (!profile) {
                // If profile doesn't exist, create it (lazy initialization)
                profile = await prisma.adminProfile.create({
                    data: { subjectId },
                });
            }

            // Fetch email from AuthService via gRPC
            let email = "";
            try {
                const authUser = await fastify.authService.getUserById(subjectId);
                email = authUser.email;
            } catch (err: any) {
                request.log.error({ err: err.message, subjectId }, "Failed to fetch admin email from AuthService gRPC");
            }

            return {
                success: true,
                data: {
                    ...profile,
                    email
                },
            };
        }
    });

    // PATCH /api/v1/user/admin/profile/me
    fastify.patch<{ Body: UpdateAdminProfileBody }>("/me", {
        schema: {
            body: updateAdminProfileSchema,
        },
        handler: async (request, reply) => {
            const prisma = request.server.prisma;
            const subjectId = (request.headers["x-admin-id"] || request.headers["x-user-id"]) as string;
            const body = request.body;

            if (!subjectId) {
                throw fastify.httpErrors.unauthorized("User ID missing in headers");
            }

            const profile = await prisma.adminProfile.upsert({
                where: { subjectId },
                update: body,
                create: {
                    subjectId,
                    ...body
                },
            });

            return {
                success: true,
                data: profile,
            };
        }
    });
}
