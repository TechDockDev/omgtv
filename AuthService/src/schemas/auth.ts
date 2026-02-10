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

export const customerLoginBodySchema = z.object({
  firebaseToken: z.string().trim().min(20),
  deviceId: deviceIdSchema,
  guestId: guestIdOptionalSchema,
  deviceInfo: deviceInfoSchema,
});

export const guestInitBodySchema = z.object({
  deviceId: deviceIdSchema,
  deviceInfo: deviceInfoSchema,
});

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshExpiresIn: z.number().int().positive(),
  tokenType: z.literal("Bearer").default("Bearer"),
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

export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>;
export type AdminRegisterBody = z.infer<typeof adminRegisterBodySchema>;
export type CustomerLoginBody = z.infer<typeof customerLoginBodySchema>;
export type GuestInitBody = z.infer<typeof guestInitBodySchema>;
export type GuestInitResponse = z.infer<typeof guestInitResponseSchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
