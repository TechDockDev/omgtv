import type { FastifyPluginAsync } from "fastify";
import {
  adminLoginBodySchema,
  adminRegisterBodySchema,
  customerLoginBodySchema,
  guestInitBodySchema,
  guestInitSuccessResponseSchema,
  tokenSuccessResponseSchema,
  tokenRefreshBodySchema,
  logoutBodySchema,
  logoutSuccessResponseSchema,
  deviceSyncBodySchema,
  deviceSyncSuccessResponseSchema,
  otpSendBodySchema,
  otpVerifyBodySchema,
  otpSendSuccessResponseSchema,
  type AdminLoginBody,
  type AdminRegisterBody,
  type CustomerLoginBody,
  type GuestInitBody,
  type GuestInitData,
  type TokenRefreshBody,
  type TokenPayload,
  type LogoutBody,
  type DeviceSyncBody,
  type OtpSendBody,
  type OtpVerifyBody,
} from "../schemas/auth.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import {
  loginAdmin,
  registerAdmin,
  loginCustomer,
  initializeGuest,
  refreshTokens,
  logoutUser,
  syncDevice,
  sendOtp,
  verifyOtp,
  getAuthProviderAnalytics,
  getOtpPhoneAnalytics,
  getOtpAnalytics,
} from "../proxy/auth.proxy";
import { createHttpError } from "../utils/errors";

const authRoutes: FastifyPluginAsync = async function authRoutes(fastify) {
  fastify.route<{
    Body: AdminLoginBody;
    Reply: TokenPayload;
  }>({
    method: "POST",
    url: "/admin/login",
    schema: {
      body: adminLoginBodySchema,
      response: {
        200: tokenSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      rateLimitPolicy: "anonymous",
      security: { bodyLimit: 16 * 1024 },
    },
    async handler(request, reply) {
      const body = adminLoginBodySchema.parse(request.body);
      const tokens = await loginAdmin(
        body,
        request.correlationId,
        request.telemetrySpan
      );

      request.log.info(
        { emailProvided: Boolean(body.email) },
        "Admin login routed to auth service"
      );

      return reply.status(200).send({ tokens, roles: tokens.roles, permissions: tokens.permissions });
    },
  });

  fastify.route<{
    Body: AdminRegisterBody;
    Reply: TokenPayload;
  }>({
    method: "POST",
    url: "/admin/register",
    schema: {
      body: adminRegisterBodySchema,
      response: {
        201: tokenSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      rateLimitPolicy: "anonymous",
      security: { bodyLimit: 16 * 1024 },
    },
    async handler(request, reply) {
      const body = adminRegisterBodySchema.parse(request.body);
      const tokens = await registerAdmin(
        body,
        request.correlationId,
        request.telemetrySpan
      );

      request.log.info(
        { emailProvided: Boolean(body.email) },
        "Admin registration routed to auth service"
      );

      return reply.status(201).send({ tokens, roles: tokens.roles, permissions: tokens.permissions });
    },
  });

  fastify.route<{
    Body: CustomerLoginBody;
    Reply: TokenPayload;
  }>({
    method: "POST",
    url: "/customer/login",
    schema: {
      body: customerLoginBodySchema,
      response: {
        200: tokenSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      // Tight limit: a legitimate user completes phone login once per session.
      // 5 attempts per IP per minute stops replay loops without blocking real users.
      gatewayRateLimit: { max: 5, timeWindowMs: 60_000 },
      security: { bodyLimit: 32 * 1024 },
    },
    async handler(request, reply) {
      const body = customerLoginBodySchema.parse(request.body);
      const tokens = await loginCustomer(
        body,
        request.correlationId,
        request.telemetrySpan
      );

      request.log.info(
        { firebaseTokenPresent: Boolean(body.firebaseToken) },
        "Customer login routed to auth service"
      );

      return reply.status(200).send({ tokens });
    },
  });

  fastify.route<{
    Body: GuestInitBody;
    Reply: GuestInitData;
  }>({
    method: "POST",
    url: "/guest/init",
    schema: {
      body: guestInitBodySchema,
      response: {
        200: guestInitSuccessResponseSchema,
        400: errorResponseSchema,
        409: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      // A real device calls guest/init once on first install.
      // 3 per IP per minute is generous for real users, tight for bots.
      gatewayRateLimit: { max: 3, timeWindowMs: 60_000 },
      security: { bodyLimit: 16 * 1024 },
    },
    async handler(request, reply) {
      const body = guestInitBodySchema.parse(request.body);
      const data = await initializeGuest(
        body,
        request.correlationId,
        request.telemetrySpan
      );

      request.log.info(
        { deviceId: body.deviceId, guestId: data.guestId },
        "Guest init routed to auth service"
      );

      return reply.status(200).send(data);
    },
  });

  fastify.route<{
    Body: TokenRefreshBody;
    Reply: TokenPayload;
  }>({
    method: "POST",
    url: "/token/refresh",
    schema: {
      body: tokenRefreshBodySchema,
      response: {
        200: tokenSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      rateLimitPolicy: "anonymous",
      security: { bodyLimit: 16 * 1024 },
    },
    async handler(request, reply) {
      const body = tokenRefreshBodySchema.parse(request.body);
      const tokens = await refreshTokens(
        body,
        request.correlationId,
        request.telemetrySpan
      );

      request.log.info(
        { refreshDeviceId: body.deviceId ?? "unspecified" },
        "Token refresh routed to auth service"
      );

      return reply.status(200).send({ tokens, roles: tokens.roles, permissions: tokens.permissions });
    },
  });

  fastify.route<{
    Body: LogoutBody;
    Reply: Record<string, never>;
  }>({
    method: "POST",
    url: "/logout",
    schema: {
      body: logoutBodySchema,
      response: {
        200: logoutSuccessResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: false },
      rateLimitPolicy: "authenticated",
      security: { bodyLimit: 8 * 1024 },
    },
    async handler(request, reply) {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        throw createHttpError(401, "Authorization header missing");
      }

      const body = logoutBodySchema.parse(request.body);

      await logoutUser(
        body,
        request.correlationId,
        authHeader,
        request.telemetrySpan
      );

      request.log.info(
        { logoutAllDevices: Boolean(body.allDevices) },
        "Logout routed to auth service"
      );

      return reply.status(200).send({});
    },
  });

  fastify.route<{
    Body: DeviceSyncBody;
    Reply: Record<string, never>;
  }>({
    method: "POST",
    url: "/device/sync",
    schema: {
      body: deviceSyncBodySchema,
      response: {
        204: deviceSyncSuccessResponseSchema,
        400: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      rateLimitPolicy: "anonymous",
      security: { bodyLimit: 8 * 1024 },
    },
    async handler(request, reply) {
      const body = deviceSyncBodySchema.parse(request.body);

      await syncDevice(body, request.correlationId, request.telemetrySpan);

      request.log.info(
        { deviceId: body.deviceId },
        "Device sync routed to auth service"
      );

      return reply.status(204).send({});
    },
  });

  fastify.route<{ Body: OtpSendBody }>({
    method: "POST",
    url: "/customer/otp/send",
    schema: {
      body: otpSendBodySchema,
      response: {
        200: otpSendSuccessResponseSchema,
        400: errorResponseSchema,
        429: errorResponseSchema,
        503: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      gatewayRateLimit: { max: 5, timeWindowMs: 60_000 },
      security: { bodyLimit: 8 * 1024 },
    },
    async handler(request, reply) {
      const body = otpSendBodySchema.parse(request.body);
      const result = await sendOtp(body, request.correlationId, request.telemetrySpan);
      return reply.status(200).send({ success: true, expiresIn: result.expiresIn });
    },
  });

  fastify.route<{ Querystring: { from?: string; to?: string; phone?: string } }>({
    method: "GET",
    url: "/admin/analytics/otp",
    config: { auth: { public: false }, rateLimitPolicy: "authenticated" },
    async handler(request, reply) {
      const { from, to, phone } = request.query;
      const data = await getOtpAnalytics({ from, to, phone }, request.correlationId, request.user);
      return reply.send(data);
    },
  });

  fastify.route({
    method: "GET",
    url: "/admin/analytics/auth-providers",
    config: { auth: { public: false }, rateLimitPolicy: "authenticated" },
    async handler(request, reply) {
      const data = await getAuthProviderAnalytics(request.correlationId, request.user);
      return reply.send(data);
    },
  });

  fastify.route<{ Params: { phone: string } }>({
    method: "GET",
    url: "/admin/analytics/otp/phone/:phone",
    config: { auth: { public: false }, rateLimitPolicy: "authenticated" },
    async handler(request, reply) {
      const { phone } = request.params;
      const data = await getOtpPhoneAnalytics(phone, request.correlationId, request.user);
      return reply.send(data);
    },
  });

  fastify.route<{ Body: OtpVerifyBody; Reply: TokenPayload }>({
    method: "POST",
    url: "/customer/otp/verify",
    schema: {
      body: otpVerifyBodySchema,
      response: {
        200: tokenSuccessResponseSchema,
        400: errorResponseSchema,
        410: errorResponseSchema,
        422: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
    config: {
      auth: { public: true },
      gatewayRateLimit: { max: 10, timeWindowMs: 60_000 },
      security: { bodyLimit: 8 * 1024 },
    },
    async handler(request, reply) {
      const body = otpVerifyBodySchema.parse(request.body);
      const tokens = await verifyOtp(body, request.correlationId, request.telemetrySpan);
      return reply.status(200).send({ tokens });
    },
  });
};

export default authRoutes;
