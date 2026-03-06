import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { loadConfig } from "../config";
import {
    forgotPasswordRequestSchema,
    verifyOtpSchema,
    resetPasswordSchema,
    type ForgotPasswordRequestBody,
    type VerifyOtpBody,
    type ResetPasswordBody
} from "../schemas/auth";

export default fp(async function forgotPasswordRoutes(fastify: FastifyInstance) {
    // POST /api/v1/auth/admin/forgot-password/request
    fastify.post<{ Body: ForgotPasswordRequestBody }>("/api/v1/auth/admin/forgot-password/request", {
        schema: {
            body: forgotPasswordRequestSchema,
        },
        handler: async (request, reply) => {
            const email = request.body.email.toLowerCase().trim();
            const prisma = request.server.prisma;
            const redis = request.server.redis;

            request.log.info({ email }, "Processing forgot password request");

            const admin = await prisma.adminCredential.findUnique({
                where: { email },
            });

            if (!admin) {
                request.log.warn({ email }, "Admin not found for forgot password");
                // Return success to avoid email enumeration
                return { success: true, message: "If an account exists, an OTP has been sent." };
            }

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const otpKey = `otp:forgot-password:${email}`;

            await redis.set(otpKey, otp, "EX", 900); // 15 minutes
            console.log("OTP sent successfully.", otp);
            try {
                request.log.info({ email }, "Attempting to send OTP email via NotificationService");
                const response = await request.server.notificationService.sendEmail({
                    to: email,
                    subject: "Your OTP for Password Reset",
                    body: `Your OTP for resetting your password is: <b>${otp}</b>. It is valid for 15 minutes.`,
                    isHtml: true,
                });

                if (!response.success) {
                    request.log.error({ email, error: response.error }, "NotificationService rejected OTP email request");
                    throw fastify.httpErrors.internalServerError("Failed to send OTP email. Please try again later.");
                }

                request.log.info({ email, notificationId: response.notificationId }, "OTP email request sent successfully to NotificationService");
            } catch (error: any) {
                request.log.error({ err: error, email }, "Failed to send reset OTP email via gRPC");
                const config = loadConfig();
                const message = config.NODE_ENV === 'development'
                    ? `Notification service unavailable: ${error.message}`
                    : "Notification service unavailable. Please try again later.";
                throw fastify.httpErrors.internalServerError(message);
            }

            return { success: true, message: "OTP sent successfully." };
        }
    });

    // POST /api/v1/auth/admin/forgot-password/verify
    fastify.post<{ Body: VerifyOtpBody }>("/api/v1/auth/admin/forgot-password/verify", {
        schema: {
            body: verifyOtpSchema,
        },
        handler: async (request, reply) => {
            const { email, otp } = request.body;
            const redis = request.server.redis;
            const otpKey = `otp:forgot-password:${email}`;

            const storedOtp = await redis.get(otpKey);

            if (!storedOtp || storedOtp !== otp) {
                throw fastify.httpErrors.badRequest("Invalid or expired OTP");
            }

            const resetToken = crypto.randomUUID();
            const resetKey = `reset-token-val:${resetToken}`;

            // Store reset token with 10 minute expiry
            await redis.set(resetKey, email, "EX", 600);
            await redis.del(otpKey);

            return { success: true, resetToken };
        }
    });

    // POST /api/v1/auth/admin/forgot-password/reset
    fastify.post<{ Body: ResetPasswordBody }>("/api/v1/auth/admin/forgot-password/reset", {
        schema: {
            body: resetPasswordSchema,
        },
        handler: async (request, reply) => {
            const { resetToken, newPassword } = request.body;
            const prisma = request.server.prisma;
            const redis = request.server.redis;

            const resetKey = `reset-token-val:${resetToken}`;
            const email = await redis.get(resetKey);

            if (!email) {
                throw fastify.httpErrors.badRequest("Invalid or expired reset token");
            }

            const passwordHash = await bcrypt.hash(newPassword, 10);

            await prisma.adminCredential.update({
                where: { email },
                data: {
                    passwordHash,
                    passwordUpdatedAt: new Date(),
                },
            });

            await redis.del(resetKey);

            return { success: true, message: "Password reset successful." };
        }
    });
});
