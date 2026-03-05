import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
    emailUpdateOptionsSchema,
    verifyEmailOtpSchema,
    type EmailUpdateOptionsBody,
    type VerifyEmailOtpBody
} from "../schemas/auth";
import { authenticateAdmin } from "../utils/auth";

export default fp(async function emailUpdateRoutes(fastify: FastifyInstance) {

    // POST /api/v1/auth/admin/update-email/request
    fastify.post<{ Body: EmailUpdateOptionsBody }>("/api/v1/auth/admin/update-email/request", {
        schema: {
            body: emailUpdateOptionsSchema,
        },
        preHandler: [authenticateAdmin],
        handler: async (request, reply) => {
            const { newEmail } = request.body;
            const redis = request.server.redis;
            const adminId = (request.user as any).adminId;

            // Generate OTP
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const otpKey = `otp:email-update:${adminId}:${newEmail}`;

            await redis.set(otpKey, otp, "EX", 900); // 15 minutes

            try {
                await request.server.notificationService.sendEmail({
                    to: newEmail,
                    subject: "Verify your new email address",
                    body: `Your OTP for updating your email to ${newEmail} is: <b>${otp}</b>. It is valid for 15 minutes.`,
                    isHtml: true,
                });
            } catch (error) {
                request.log.error({ err: error }, "Failed to send email update OTP");
            }

            return { success: true, message: "OTP sent to your new email address." };
        }
    });

    // POST /api/v1/auth/admin/update-email/verify
    fastify.post<{ Body: VerifyEmailOtpBody }>("/api/v1/auth/admin/update-email/verify", {
        schema: {
            body: verifyEmailOtpSchema,
        },
        preHandler: [authenticateAdmin],
        handler: async (request, reply) => {
            const { newEmail, otp } = request.body;
            const prisma = request.server.prisma;
            const redis = request.server.redis;
            const adminId = (request.user as any).adminId;
            const subjectId = request.user.sub;

            const otpKey = `otp:email-update:${adminId}:${newEmail}`;
            const storedOtp = await redis.get(otpKey);

            if (!storedOtp || storedOtp !== otp) {
                throw fastify.httpErrors.unauthorized("Invalid or expired OTP");
            }

            // Check if email is already taken
            const existing = await prisma.adminCredential.findUnique({
                where: { email: newEmail },
            });

            if (existing) {
                throw fastify.httpErrors.conflict("Email already in use");
            }

            // Update email
            await prisma.adminCredential.update({
                where: { subjectId },
                data: { email: newEmail },
            });

            await redis.del(otpKey);

            return { success: true, message: "Email updated successfully." };
        }
    });
});
