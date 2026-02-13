import { z } from "zod";
import {
  createSuccessResponseSchema,
  errorResponseSchema,
} from "./base.schema";
import type { SuccessResponse, ErrorResponse } from "../utils/envelope";

const deviceIdSchema = z.string().trim().min(3).max(128);

const guestIdOptionalSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().trim().min(3).max(128).optional());

const deviceInfoSchema = z.object({
  os: z.string().optional(),
  osVersion: z.string().optional(),
  deviceName: z.string().optional(),
  model: z.string().optional(),
  appVersion: z.string().optional(),
  network: z.string().optional(),
  fcmToken: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
}).optional();

export const adminLoginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(8),
});

export const adminRegisterBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(8),
});

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
  tokenType: z.literal("Bearer"),
});

export const guestInitDataSchema = z.object({
  guestId: z.string().min(3).max(128),
  tokens: tokenResponseSchema,
});

export const tokenPayloadSchema = z.object({
  tokens: tokenResponseSchema,
});

export const tokenSuccessResponseSchema =
  createSuccessResponseSchema(tokenPayloadSchema);

export const guestInitSuccessResponseSchema =
  createSuccessResponseSchema(guestInitDataSchema);

export const logoutSuccessResponseSchema = createSuccessResponseSchema(
  z.object({}).strict()
);

export const deviceSyncSuccessResponseSchema = createSuccessResponseSchema(
  z.object({}).strict()
);

export const tokenRefreshBodySchema = z.object({
  refreshToken: z.string().trim().min(1),
  deviceId: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.string().trim().min(3).max(128).optional()
  ),
});

export const logoutBodySchema = z
  .object({
    refreshToken: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim() || undefined : value,
      z.string().trim().min(1).optional()
    ),
    deviceId: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim() || undefined : value,
      z.string().trim().min(3).max(128).optional()
    ),
    allDevices: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.allDevices || value.refreshToken || value.deviceId),
    {
      message: "Provide refreshToken, deviceId, or set allDevices",
      path: ["refreshToken"],
    }
  );

export const deviceSyncBodySchema = z.object({
  deviceId: deviceIdSchema,
  deviceInfo: deviceInfoSchema.unwrap(),
});

export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>;
export type AdminRegisterBody = z.infer<typeof adminRegisterBodySchema>;
export type CustomerLoginBody = z.infer<typeof customerLoginBodySchema>;
export type GuestInitBody = z.infer<typeof guestInitBodySchema>;
export type TokenRefreshBody = z.infer<typeof tokenRefreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type GuestInitData = z.infer<typeof guestInitDataSchema>;
export type DeviceSyncBody = z.infer<typeof deviceSyncBodySchema>;
export type TokenPayload = z.infer<typeof tokenPayloadSchema>;
export type TokenSuccessResponse = SuccessResponse<TokenPayload>;
export type GuestInitSuccessResponse = SuccessResponse<GuestInitData>;
export type LogoutSuccessResponse = SuccessResponse<Record<string, never>>;
export type ErrorEnvelope = ErrorResponse;
