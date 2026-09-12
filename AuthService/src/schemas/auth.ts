import { z } from "zod";

const deviceIdSchema = z.string().trim().min(3).max(128);

const guestIdOptionalSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(3).max(128).optional());

export const adminLoginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(8),
});

export const adminRegisterBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(8),
});

export const deviceInfoSchema = z.object({
  os: z.string().optional(),
  osVersion: z.string().optional(),
  deviceName: z.string().optional(),
  model: z.string().optional(),
  appVersion: z.string().optional(),
  network: z.string().optional(),
  fcmToken: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
}).optional();

export const attributionSchema = z.object({
  source: z.string().trim().min(1).max(32).optional(),
  campaignId: z.string().trim().min(1).max(128).optional(),
  adsetId: z.string().trim().min(1).max(128).optional(),
  adId: z.string().trim().min(1).max(128).optional(),
  // Series/episode/reel ID the deep link pointed to (e.g. the "f0faa2eb-..."
  // segment in omgtv://show/f0faa2eb-...?source=meta&campaign_id=...).
  contentId: z.string().trim().min(1).max(128).optional(),
}).optional();

export const customerLoginBodySchema = z.object({
  firebaseToken: z.string().trim().min(20),
  deviceId: deviceIdSchema,
  guestId: guestIdOptionalSchema,
  deviceInfo: deviceInfoSchema,
  attribution: attributionSchema,
});

export const guestInitBodySchema = z.object({
  deviceId: deviceIdSchema,
  deviceInfo: deviceInfoSchema,
  attribution: attributionSchema,
});

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshExpiresIn: z.number().int().positive(),
  tokenType: z.literal("Bearer").default("Bearer"),
  roles: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  // Only meaningful for customer login/registration (DLT + Firebase) — true
  // only on a user's very first-ever registration. Absent for admin login,
  // guest tokens, and refresh, since "new user" doesn't apply there.
  isNewUser: z.boolean().optional(),
});

export const guestInitResponseSchema = z.object({
  guestId: z.string().min(3).max(128),
  tokens: tokenResponseSchema,
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().trim().min(1),
  deviceId: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.string().min(3).max(128).optional()
  ),
});

export const logoutBodySchema = z
  .object({
    refreshToken: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim() || undefined : value,
      z.string().min(1).optional()
    ),
    deviceId: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim() || undefined : value,
      z.string().min(3).max(128).optional()
    ),
    allDevices: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.allDevices || value.refreshToken || value.deviceId),
    {
      message: "Provide refreshToken, deviceId, or set allDevices to true",
      path: ["refreshToken"],
    }
  );

export const deviceSyncBodySchema = z.object({
  deviceId: deviceIdSchema,
  deviceInfo: deviceInfoSchema.unwrap(), // schema is optional() in definition, need to unwrap for required object here but Zod's optional() is a bit different. Actually deviceInfoSchema itself is z.object(...).optional().
});

// Re-defining for clarity/correctness if needed, or just use:
export const deviceSyncBodySchemaMinimal = z.object({
  deviceId: deviceIdSchema,
  deviceInfo: z.object({
    os: z.string().optional(),
    osVersion: z.string().optional(),
    deviceName: z.string().optional(),
    model: z.string().optional(),
    appVersion: z.string().optional(),
    network: z.string().optional(),
    fcmToken: z.string().optional(),
    permissions: z.record(z.boolean()).optional(),
  }),
});

export const otpSendBodySchema = z.object({
  phone: z.string().trim().regex(/^\+91[6-9]\d{9}$/, "Must be a valid Indian mobile number with +91 prefix"),
  deviceId: deviceIdSchema,
  deviceInfo: deviceInfoSchema,
});

export const otpVerifyBodySchema = z.object({
  phone: z.string().trim().regex(/^\+91[6-9]\d{9}$/, "Must be a valid Indian mobile number with +91 prefix"),
  otp: z.string().trim().length(6),
  deviceId: deviceIdSchema,
  guestId: guestIdOptionalSchema,
  deviceInfo: deviceInfoSchema,
  attribution: attributionSchema,
});

// guestId is optional at the schema level — required only when the caller has
// no auth token, which the route handler checks explicitly (it knows whether
// a bearer token was present, the schema doesn't).
export const attributionTrackBodySchema = z.object({
  eventType: z.enum(["install", "reengagement"]),
  source: z.string().trim().min(1).max(32),
  campaignId: z.string().trim().min(1).max(128).optional(),
  adsetId: z.string().trim().min(1).max(128).optional(),
  adId: z.string().trim().min(1).max(128).optional(),
  contentId: z.string().trim().min(1).max(128).optional(),
  guestId: guestIdOptionalSchema,
});

export const otpSendResponseSchema = z.object({
  success: z.boolean(),
  expiresIn: z.number(),
});

export const forgotPasswordRequestSchema = z.object({
  email: z.string().trim().email(),
});

export const verifyOtpSchema = z.object({
  email: z.string().trim().email(),
  otp: z.string().length(6),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().trim().min(8),
});

export const emailUpdateOptionsSchema = z.object({
  newEmail: z.string().trim().email(),
});

export const verifyEmailOtpSchema = z.object({
  newEmail: z.string().trim().email(),
  otp: z.string().length(6),
});

export const updatePasswordSchema = z.object({
  oldPassword: z.string().trim().min(1),
  newPassword: z.string().trim().min(8),
});

export type Attribution = z.infer<typeof attributionSchema>;
export type AttributionTrackBody = z.infer<typeof attributionTrackBodySchema>;
export type OtpSendBody = z.infer<typeof otpSendBodySchema>;
export type OtpVerifyBody = z.infer<typeof otpVerifyBodySchema>;
export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>;
export type AdminRegisterBody = z.infer<typeof adminRegisterBodySchema>;
export type CustomerLoginBody = z.infer<typeof customerLoginBodySchema>;
export type GuestInitBody = z.infer<typeof guestInitBodySchema>;
export type GuestInitResponse = z.infer<typeof guestInitResponseSchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type DeviceSyncBody = z.infer<typeof deviceSyncBodySchemaMinimal>;
export type ForgotPasswordRequestBody = z.infer<typeof forgotPasswordRequestSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type EmailUpdateOptionsBody = z.infer<typeof emailUpdateOptionsSchema>;
export type VerifyEmailOtpBody = z.infer<typeof verifyEmailOtpSchema>;
export type UpdatePasswordBody = z.infer<typeof updatePasswordSchema>;
