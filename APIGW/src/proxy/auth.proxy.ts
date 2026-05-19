import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";
import {
  adminLoginBodySchema,
  adminRegisterBodySchema,
  customerLoginBodySchema,
  guestInitBodySchema,
  guestInitDataSchema,
  tokenResponseSchema,
  tokenRefreshBodySchema,
  logoutBodySchema,
  otpSendBodySchema,
  otpVerifyBodySchema,
  otpSendResponseSchema,
  type AdminLoginBody,
  type AdminRegisterBody,
  type CustomerLoginBody,
  type GuestInitBody,
  type GuestInitData,
  type TokenRefreshBody,
  type LogoutBody,
  type TokenResponse,
  type DeviceSyncBody,
  type OtpSendBody,
  type OtpVerifyBody,
  deviceSyncBodySchema,
} from "../schemas/auth.schema";

function summarizeValue(value: unknown): unknown {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `string(len=${value.length})`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return `array(len=${value.length})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => [key, summarizeValue(val)]
    );
    return Object.fromEntries(entries);
  }
  return typeof value;
}

export async function loginAdmin(
  body: AdminLoginBody,
  correlationId: string,
  span?: Span
): Promise<TokenResponse> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = adminLoginBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<TokenResponse>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/admin/login",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:admin-login",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 401) {
        throw createHttpError(401, "Invalid credentials", error.cause);
      }
      if (error.statusCode === 403) {
        throw createHttpError(403, "Admin account disabled", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from auth service");
  }

  return parsed.data;
}

export async function registerAdmin(
  body: AdminRegisterBody,
  correlationId: string,
  span?: Span
): Promise<TokenResponse> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = adminRegisterBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<TokenResponse>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/admin/register",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:admin-register",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 409) {
        throw createHttpError(409, "Admin email already exists", error.cause);
      }
      if (error.statusCode === 401) {
        throw createHttpError(
          401,
          "Invalid registration credentials",
          error.cause
        );
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from auth service");
  }

  return parsed.data;
}

export async function loginCustomer(
  body: CustomerLoginBody,
  correlationId: string,
  span?: Span
): Promise<TokenResponse> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = customerLoginBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<TokenResponse>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/customer/login",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:customer-login",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 401) {
        throw createHttpError(401, "Firebase token rejected", error.cause);
      }
      if (error.statusCode === 409) {
        throw createHttpError(409, "Guest already migrated", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from auth service");
  }

  return parsed.data;
}

export async function initializeGuest(
  body: GuestInitBody,
  correlationId: string,
  span?: Span
): Promise<GuestInitData> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = guestInitBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<GuestInitData>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/guest/init",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:guest-init",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 409) {
        throw createHttpError(409, "Guest already migrated", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }

  if (payload && typeof payload === "object") {
    const candidate = payload as {
      guestId?: unknown;
      tokens?: unknown;
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresIn?: unknown;
      refreshExpiresIn?: unknown;
      tokenType?: unknown;
    };

    if (
      typeof candidate.guestId === "string" &&
      candidate.tokens &&
      typeof candidate.tokens === "object"
    ) {
      const tokens = normalizeTokenPayload(candidate.tokens);
      return {
        guestId: candidate.guestId,
        tokens,
      };
    }

    if (typeof candidate.guestId === "string") {
      const tokens = normalizeTokenPayload(candidate);
      return {
        guestId: candidate.guestId,
        tokens,
      };
    }
  }

  const parsed = guestInitDataSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const shape = summarizeValue(payload);
  throw new Error(
    `Invalid response from auth service (shape=${JSON.stringify(shape)})`
  );
}

function normalizeTokenPayload(payload: unknown): TokenResponse {
  const source = (payload ?? {}) as Record<string, unknown>;
  const accessToken = source.accessToken;
  const refreshToken = source.refreshToken;
  const expiresIn = source.expiresIn;
  const refreshExpiresIn = source.refreshExpiresIn;
  const tokenType = source.tokenType;

  return {
    accessToken: typeof accessToken === "string" ? accessToken : "",
    refreshToken: typeof refreshToken === "string" ? refreshToken : "",
    expiresIn:
      typeof expiresIn === "number"
        ? expiresIn
        : Math.max(Number.parseInt(String(expiresIn ?? 0), 10) || 0, 0),
    refreshExpiresIn:
      typeof refreshExpiresIn === "number"
        ? refreshExpiresIn
        : Math.max(
          Number.parseInt(
            String(
              refreshExpiresIn !== undefined
                ? refreshExpiresIn
                : (expiresIn ?? 0)
            ),
            10
          ) || 0,
          0
        ),
    tokenType: "Bearer",
    roles: Array.isArray(source.roles) ? source.roles.map(String) : undefined,
    permissions: Array.isArray(source.permissions) ? source.permissions.map(String) : undefined,
  };
}

export async function refreshTokens(
  body: TokenRefreshBody,
  correlationId: string,
  span?: Span
): Promise<TokenResponse> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = tokenRefreshBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<TokenResponse>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/token/refresh",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:refresh",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 401) {
        throw createHttpError(401, "Refresh token invalid", error.cause);
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from auth service");
  }

  return parsed.data;
}

export async function logoutUser(
  body: LogoutBody,
  correlationId: string,
  accessToken: string,
  span?: Span
): Promise<void> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = logoutBodySchema.parse(body);

  try {
    await performServiceRequest<void>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/logout",
      method: "POST",
      correlationId,
      body: validatedBody,
      headers: {
        authorization: accessToken,
      },
      parentSpan: span,
      spanName: "proxy:auth:logout",
    });
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 401) {
        throw createHttpError(
          401,
          "Logout requires authentication",
          error.cause
        );
      }
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }
}

export async function syncDevice(
  body: DeviceSyncBody,
  correlationId: string,
  span?: Span
): Promise<void> {
  const baseUrl = resolveServiceUrl("auth");

  const validatedBody = deviceSyncBodySchema.parse(body);

  try {
    await performServiceRequest<void>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/device/sync",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:device-sync",
    });
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        Math.min(error.statusCode, 502),
        "Authentication service error",
        error.cause
      );
    }
    throw error;
  }
}

export async function sendOtp(
  body: OtpSendBody,
  correlationId: string,
  span?: Span
): Promise<{ success: boolean; expiresIn: number }> {
  const baseUrl = resolveServiceUrl("auth");
  const validatedBody = otpSendBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<{ success: boolean; expiresIn: number }>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/customer/otp/send",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:otp-send",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 429) throw createHttpError(429, "Too many OTP requests", error.cause);
      if (error.statusCode === 503) throw createHttpError(503, "OTP service unavailable", error.cause);
      throw createHttpError(Math.min(error.statusCode, 502), "OTP send failed", error.cause);
    }
    throw error;
  }

  const parsed = otpSendResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid response from auth service");
  return parsed.data;
}

export async function verifyOtp(
  body: OtpVerifyBody,
  correlationId: string,
  span?: Span
): Promise<TokenResponse> {
  const baseUrl = resolveServiceUrl("auth");
  const validatedBody = otpVerifyBodySchema.parse(body);

  let payload: unknown;
  try {
    const response = await performServiceRequest<TokenResponse>({
      serviceName: "auth",
      baseUrl,
      path: "/api/v1/auth/customer/otp/verify",
      method: "POST",
      correlationId,
      body: validatedBody,
      parentSpan: span,
      spanName: "proxy:auth:otp-verify",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      if (error.statusCode === 422) throw createHttpError(422, "Invalid or incorrect OTP", error.cause);
      if (error.statusCode === 410) throw createHttpError(410, "OTP expired", error.cause);
      if (error.statusCode === 429) throw createHttpError(429, "Too many attempts", error.cause);
      throw createHttpError(Math.min(error.statusCode, 502), "OTP verification failed", error.cause);
    }
    throw error;
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid response from auth service");
  return parsed.data;
}

export async function getOtpAnalytics(
  params: { from?: string; to?: string; phone?: string },
  correlationId: string
): Promise<unknown> {
  const baseUrl = resolveServiceUrl("auth");
  const query = new URLSearchParams();
  if (params.from) query.append("from", params.from);
  if (params.to) query.append("to", params.to);
  if (params.phone) query.append("phone", params.phone);
  const qs = query.toString();
  const response = await performServiceRequest<unknown>({
    serviceName: "auth",
    baseUrl,
    path: `/api/v1/auth/admin/analytics/otp${qs ? `?${qs}` : ""}`,
    method: "GET",
    correlationId,
    spanName: "proxy:auth:analytics-otp",
  });
  return response.payload;
}

export async function getAuthProviderAnalytics(
  correlationId: string
): Promise<unknown> {
  const baseUrl = resolveServiceUrl("auth");
  const response = await performServiceRequest<unknown>({
    serviceName: "auth",
    baseUrl,
    path: "/api/v1/auth/admin/analytics/auth-providers",
    method: "GET",
    correlationId,
    spanName: "proxy:auth:analytics-auth-providers",
  });
  return response.payload;
}

export async function getOtpPhoneAnalytics(
  phone: string,
  correlationId: string
): Promise<unknown> {
  const baseUrl = resolveServiceUrl("auth");
  const response = await performServiceRequest<unknown>({
    serviceName: "auth",
    baseUrl,
    path: `/api/v1/auth/admin/analytics/otp/phone/${encodeURIComponent(phone)}`,
    method: "GET",
    correlationId,
    spanName: "proxy:auth:analytics-otp-phone",
  });
  return response.payload;
}
