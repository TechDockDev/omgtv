import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  loginAdmin,
  registerAdmin,
  authenticateCustomer,
  initializeGuest,
  rotateRefreshToken,
  revokeSessions,
  verifyActiveSession,
  AuthError,
} from "../services/auth";
import {
  adminLoginBodySchema,
  adminRegisterBodySchema,
  customerLoginBodySchema,
  guestInitBodySchema,
  refreshBodySchema,
  logoutBodySchema,
  type AdminLoginBody,
  type AdminRegisterBody,
  type CustomerLoginBody,
  type GuestInitBody,
  type GuestInitResponse,
  type RefreshBody,
  type LogoutBody,
} from "../schemas/auth";

function mapAuthError(fastify: FastifyInstance, error: AuthError): never {
  switch (error.code) {
    case "INVALID_CREDENTIALS":
      throw fastify.httpErrors.unauthorized("Invalid credentials");
    case "ADMIN_EMAIL_EXISTS":
      throw fastify.httpErrors.conflict("Admin email already exists");
    case "ACCOUNT_DISABLED":
      throw fastify.httpErrors.forbidden("Account disabled");
    case "GUEST_MIGRATED":
      throw fastify.httpErrors.conflict("Guest account migrated");
    case "EXPIRED_REFRESH_TOKEN":
      throw fastify.httpErrors.unauthorized("Refresh token expired");
    case "DEVICE_MISMATCH":
    case "INVALID_REFRESH_TOKEN":
      throw fastify.httpErrors.unauthorized("Invalid refresh token");
    case "USER_DISABLED":
      throw fastify.httpErrors.forbidden("User disabled");
    default:
      throw fastify.httpErrors.internalServerError();
  }
}

export default fp(async function publicAuthRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: AdminLoginBody }>("/api/v1/auth/admin/login", {
    schema: {
      body: adminLoginBodySchema,
    },
    handler: async (request) => {
      const body = adminLoginBodySchema.parse(request.body);
      try {
        return await loginAdmin({
          prisma: request.server.prisma,
          email: body.email,
          password: body.password,
          signAccessToken: request.server.signAccessToken,
          userService: request.server.userService,
          logger: request.log,
          redis: request.server.redis,
        });
      } catch (error) {
        if (error instanceof AuthError) {
          mapAuthError(fastify, error);
        }
        request.log.error({ err: error }, "Admin login failed");
        throw fastify.httpErrors.internalServerError();
      }
    },
  });

  fastify.post<{ Body: AdminRegisterBody }>(
    "/api/v1/auth/admin/register",
    {
      schema: {
        body: adminRegisterBodySchema,
      },
    },
    async (request, reply) => {
      const body = adminRegisterBodySchema.parse(request.body);
      try {
        const tokens = await registerAdmin({
          prisma: request.server.prisma,
          email: body.email,
          password: body.password,
          signAccessToken: request.server.signAccessToken,
          userService: request.server.userService,
          logger: request.log,
          redis: request.server.redis,
        });
        return reply.status(201).send(tokens);
      } catch (error) {
        if (error instanceof AuthError) {
          mapAuthError(fastify, error);
        }
        if ((error as { code?: string }).code === "P2002") {
          throw fastify.httpErrors.conflict("Admin email already exists");
        }
        request.log.error({ err: error }, "Admin registration failed");
        throw fastify.httpErrors.internalServerError();
      }
    }
  );

  fastify.post<{ Body: CustomerLoginBody }>("/api/v1/auth/customer/login", {
    schema: {
      body: customerLoginBodySchema,
    },
    handler: async (request) => {
      const body = customerLoginBodySchema.parse(request.body);
      try {
        return await authenticateCustomer({
          prisma: request.server.prisma,
          firebaseAuth: request.server.firebaseAuth,
          firebaseToken: body.firebaseToken,
          deviceId: body.deviceId,
          guestId: body.guestId,
          signAccessToken: request.server.signAccessToken,
          userService: request.server.userService,
          logger: request.log,
          redis: request.server.redis,
        });
      } catch (error) {
        if (error instanceof AuthError) {
          mapAuthError(fastify, error);
        }
        if (error instanceof Error && error.message.includes("verifyIdToken")) {
          throw fastify.httpErrors.unauthorized("Invalid Firebase token");
        }
        request.log.error({ err: error }, "Customer login failed");
        throw fastify.httpErrors.internalServerError();
      }
    },
  });

  fastify.post<{ Body: GuestInitBody; Reply: GuestInitResponse }>(
    "/api/v1/auth/guest/init",
    {
      schema: {
        body: guestInitBodySchema,
      },
    },
    async (request) => {
      const body = guestInitBodySchema.parse(request.body);
      try {
        const result = await initializeGuest({
          prisma: request.server.prisma,
          guestId: undefined,
          deviceId: body.deviceId,
          signAccessToken: request.server.signAccessToken,
          userService: request.server.userService,
          redis: request.server.redis,
        });
        return { guestId: result.guestId, tokens: result.tokens };
      } catch (error) {
        if (error instanceof AuthError) {
          mapAuthError(fastify, error);
        }
        request.log.error({ err: error }, "Guest token initialization failed");
        throw fastify.httpErrors.internalServerError();
      }
    }
  );

  fastify.post<{ Body: RefreshBody }>("/api/v1/auth/token/refresh", {
    schema: {
      body: refreshBodySchema,
    },
    handler: async (request) => {
      const body = refreshBodySchema.parse(request.body);
      try {
        return await rotateRefreshToken({
          prisma: request.server.prisma,
          refreshToken: body.refreshToken,
          deviceId: body.deviceId,
          signAccessToken: request.server.signAccessToken,
          userService: request.server.userService,
          logger: request.log,
          redis: request.server.redis,
        });
      } catch (error) {
        if (error instanceof AuthError) {
          mapAuthError(fastify, error);
        }
        request.log.error({ err: error }, "Token refresh failed");
        throw fastify.httpErrors.internalServerError();
      }
    },
  });

  fastify.post<{ Body: LogoutBody }>("/api/v1/auth/logout", {
    schema: {
      body: logoutBodySchema,
    },
    handler: async (request, reply) => {
      const body = logoutBodySchema.parse(request.body);
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        throw fastify.httpErrors.unauthorized("Missing access token");
      }
      const token = authHeader.replace(/^Bearer\s+/i, "");
      let payload: { sub?: string };
      try {
        payload = await request.server.jwt.verify(token);
      } catch (error) {
        request.log.warn({ err: error }, "Access token verification failed");
        throw fastify.httpErrors.unauthorized("Invalid access token");
      }

      const subjectId = payload.sub;
      if (!subjectId) {
        throw fastify.httpErrors.unauthorized("Invalid subject");
      }

      await revokeSessions({
        prisma: request.server.prisma,
        subjectId,
        refreshToken: body.refreshToken,
        deviceId: body.deviceId,
        allDevices: body.allDevices,
      });

      return reply.status(204).send();
    },
  });


  fastify.get<{ Reply: { valid: boolean } }>("/api/v1/auth/session/verify", {
    handler: async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        throw fastify.httpErrors.unauthorized("Missing access token");
      }
      const token = authHeader.replace(/^Bearer\s+/i, "");
      request.log.info({ tokenPrefix: token.substring(0, 10), tokenLength: token.length }, "Verifying session token");
      let payload;
      try {
        payload = await request.server.jwt.verify(token);
      } catch (error) {
        request.log.error({ err: error }, "Token verification failed inside verify endpoint");
        throw fastify.httpErrors.unauthorized("Invalid access token");
      }

      const { sub: subjectId, sessionId } = payload;
      if (!subjectId || !sessionId) {
        throw fastify.httpErrors.unauthorized("Invalid token payload");
      }

      const isValid = await verifyActiveSession({
        redis: request.server.redis,
        subjectId,
        sessionId,
      });

      if (!isValid) {
        throw fastify.httpErrors.unauthorized("Session revoked or invalid");
      }

      return { valid: true };
    },
  });
});
