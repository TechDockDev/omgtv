import {
  AuthSubjectType,
  GuestLifecycleStatus,
  PrismaClient,
} from "@prisma/client";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config";
import type { TokenResponse } from "../schemas/auth";
import type { FirebaseAuthIntegration } from "../plugins/firebase";
import type { AccessTokenPayload } from "../plugins/jwt";
import type { UserServiceIntegration } from "../types/user-service";
import { hashPassword, verifyPassword } from "../utils/password";
import type { Redis } from "ioredis";

const config = loadConfig();

const ACTIVE_SESSION_PREFIX = "active_session:";

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "ADMIN_EMAIL_EXISTS"
  | "ACCOUNT_DISABLED"
  | "GUEST_MIGRATED"
  | "INVALID_REFRESH_TOKEN"
  | "EXPIRED_REFRESH_TOKEN"
  | "USER_DISABLED"
  | "DEVICE_MISMATCH";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: AuthErrorCode
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function createRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function issueSessionTokens(params: {
  prisma: PrismaClient;
  redis: Redis;
  subjectId: string;
  payload: AccessTokenPayload;
  signAccessToken:
  | ((payload: AccessTokenPayload, expiresIn?: number) => Promise<string>)
  | undefined;
  deviceId?: string;
  userAgent?: string;
}): Promise<TokenResponse> {
  const {
    prisma,
    redis,
    subjectId,
    payload,
    signAccessToken,
    deviceId,
    userAgent,
  } = params;

  const refreshToken = createRefreshToken();
  const hashedRefresh = hashToken(refreshToken);
  const refreshExpiresAt = new Date(
    Date.now() + config.REFRESH_TOKEN_TTL * 1000
  );

  // SINGLE DEVICE LOGIN ENFORCEMENT
  // 1. Delete all previous sessions from the database
  await prisma.session.deleteMany({
    where: {
      subjectId,
    },
  });

  const session = await prisma.session.create({
    data: {
      subjectId,
      refreshTokenHash: hashedRefresh,
      expiresAt: refreshExpiresAt,
      deviceId,
      userAgent,
    },
  });

  // 2. Set the active session in Redis (The "Heartbeat" Record)
  // We use the Session ID (UUID) as the value.
  // Set expiry to match Refresh Token TTL so it doesn't leak memory forever.
  await redis.set(
    `${ACTIVE_SESSION_PREFIX}${subjectId}`,
    session.id,
    "EX",
    config.REFRESH_TOKEN_TTL
  );

  // Add sessionId to the access token payload for validation
  const sessionPayload = { ...payload, sessionId: session.id };
  const accessToken = signAccessToken
    ? await signAccessToken(sessionPayload, config.ACCESS_TOKEN_TTL)
    : ""; // If triggered internally without signing

  return {
    accessToken,
    refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL,
    refreshExpiresIn: config.REFRESH_TOKEN_TTL,
    tokenType: "Bearer",
  };
}

async function gatherAdminRoles(params: {
  userService: UserServiceIntegration;
  subjectId: string;
  logger: FastifyBaseLogger;
}): Promise<string[]> {
  const { userService, subjectId, logger } = params;
  if (!userService.isEnabled) {
    logger.warn(
      { subjectId },
      "UserService integration disabled; issuing admin token without roles"
    );
    return [];
  }

  try {
    const context = await userService.getUserContext(subjectId);
    const assignments = context.assignments.filter(
      (assignment) => assignment.active
    );
    const roles = new Set<string>();
    for (const assignment of assignments) {
      roles.add(assignment.role.name);
    }
    return [...roles];
  } catch (error) {
    logger.error(
      { err: error, subjectId },
      "Failed to fetch admin roles from UserService"
    );
    throw new Error("Unable to resolve admin roles");
  }
}

async function upsertCustomerSubject(params: {
  prisma: PrismaClient;
  firebaseUid: string;
  customerId: string;
}): Promise<{
  subjectId: string;
  customerId: string;
  firebaseUid: string;
}> {
  const { prisma, firebaseUid, customerId } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.customerIdentity.findFirst({
      where: {
        OR: [{ firebaseUid }, { customerId }],
      },
    });

    if (existing) {
      const updated = await tx.customerIdentity.update({
        where: { subjectId: existing.subjectId },
        data: {
          firebaseUid,
          customerId,
          lastLoginAt: new Date(),
        },
      });
      return {
        subjectId: updated.subjectId,
        customerId: updated.customerId,
        firebaseUid: updated.firebaseUid,
      };
    }

    const subject = await tx.authSubject.create({
      data: {
        type: AuthSubjectType.CUSTOMER,
        customer: {
          create: {
            firebaseUid,
            customerId,
            lastLoginAt: new Date(),
          },
        },
      },
      include: {
        customer: true,
      },
    });

    if (!subject.customer) {
      throw new Error("Failed to create customer identity");
    }

    return {
      subjectId: subject.id,
      customerId: subject.customer.customerId,
      firebaseUid: subject.customer.firebaseUid,
    };
  });
}

async function ensureGuestSubject(params: {
  prisma: PrismaClient;
  guestId: string;
  deviceId: string;
  guestProfileId: string;
}): Promise<{
  subjectId: string;
  guestProfileId: string;
  status: GuestLifecycleStatus;
}> {
  const { prisma, guestId, deviceId, guestProfileId } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.guestIdentity.findUnique({
      where: { guestProfileId },
    });

    if (existing) {
      const updated = await tx.guestIdentity.update({
        where: { guestProfileId },
        data: {
          status: GuestLifecycleStatus.ACTIVE,
        },
      });
      return {
        subjectId: updated.subjectId,
        guestProfileId: updated.guestProfileId,
        status: updated.status,
      };
    }

    const subject = await tx.authSubject.create({
      data: {
        type: AuthSubjectType.GUEST,
        guest: {
          create: {
            guestId,
            deviceId,
            guestProfileId,
          },
        },
      },
      include: {
        guest: true,
      },
    });

    if (!subject.guest) {
      throw new Error("Failed to create guest identity");
    }

    return {
      subjectId: subject.id,
      guestProfileId: subject.guest.guestProfileId,
      status: subject.guest.status,
    };
  });
}

async function buildAccessPayload(params: {
  prisma: PrismaClient;
  subjectId: string;
  userService: UserServiceIntegration;
  logger: FastifyBaseLogger;
  deviceId?: string;
}): Promise<AccessTokenPayload> {
  const { prisma, subjectId, userService, logger, deviceId } = params;

  const subject = await prisma.authSubject.findUnique({
    where: { id: subjectId },
    include: {
      admin: true,
      customer: true,
      guest: true,
    },
  });

  if (!subject) {
    throw new AuthError("Subject not found", "INVALID_REFRESH_TOKEN");
  }

  switch (subject.type) {
    case AuthSubjectType.ADMIN: {
      if (!subject.admin) {
        throw new AuthError("Admin credentials missing", "ACCOUNT_DISABLED");
      }
      if (!subject.admin.isActive) {
        throw new AuthError("Admin account disabled", "ACCOUNT_DISABLED");
      }
      const roles = await gatherAdminRoles({
        userService,
        subjectId: subject.id,
        logger,
      });
      return {
        sub: subject.id,
        userType: "ADMIN",
        adminId: subject.id,
        roles,
      };
    }
    case AuthSubjectType.CUSTOMER: {
      if (!subject.customer) {
        throw new AuthError(
          "Customer identity missing",
          "INVALID_REFRESH_TOKEN"
        );
      }
      if (!deviceId) {
        throw new AuthError("Device required", "DEVICE_MISMATCH");
      }
      return {
        sub: subject.id,
        userType: "CUSTOMER",
        userId: subject.customer.customerId,
        firebaseUid: subject.customer.firebaseUid,
        deviceId,
      };
    }
    case AuthSubjectType.GUEST: {
      if (!subject.guest) {
        throw new AuthError("Guest identity missing", "INVALID_REFRESH_TOKEN");
      }
      if (subject.guest.status === GuestLifecycleStatus.MIGRATED) {
        throw new AuthError("Guest migrated", "GUEST_MIGRATED");
      }
      if (!deviceId) {
        throw new AuthError("Device required", "DEVICE_MISMATCH");
      }
      return {
        sub: subject.id,
        userType: "GUEST",
        guestId: subject.guest.guestId,
        deviceId,
        guestProfileId: subject.guest.guestProfileId,
      };
    }
    default: {
      throw new AuthError("Unsupported subject type", "INVALID_REFRESH_TOKEN");
    }
  }
}

export async function loginAdmin(params: {
  prisma: PrismaClient;
  email: string;
  password: string;
  signAccessToken: (
    payload: AccessTokenPayload,
    expiresIn?: number
  ) => Promise<string>;
  userService: UserServiceIntegration;
  logger: FastifyBaseLogger;
  redis: Redis;
}): Promise<TokenResponse> {
  const { prisma, email, password, signAccessToken, userService, logger, redis } =
    params;

  const credential = await prisma.adminCredential.findUnique({
    where: { email },
  });

  if (!credential) {
    throw new AuthError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  if (!credential.isActive) {
    throw new AuthError("Admin account disabled", "ACCOUNT_DISABLED");
  }

  const valid = await verifyPassword(password, credential.passwordHash);
  if (!valid) {
    throw new AuthError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  const roles = await gatherAdminRoles({
    userService,
    subjectId: credential.subjectId,
    logger,
  });

  const payload: AccessTokenPayload = {
    sub: credential.subjectId,
    userType: "ADMIN",
    adminId: credential.subjectId,
    roles,
  };

  return issueSessionTokens({
    prisma,
    redis,
    subjectId: credential.subjectId,
    payload,
    signAccessToken,
  });
}

export async function registerAdmin(params: {
  prisma: PrismaClient;
  email: string;
  password: string;
  signAccessToken: (
    payload: AccessTokenPayload,
    expiresIn?: number
  ) => Promise<string>;
  userService: UserServiceIntegration;
  logger: FastifyBaseLogger;
  redis: Redis;
}): Promise<TokenResponse> {
  const { prisma, email, password, signAccessToken, userService, logger, redis } =
    params;

  const existing = await prisma.adminCredential.findUnique({
    where: { email },
  });
  if (existing) {
    throw new AuthError("Admin email already exists", "ADMIN_EMAIL_EXISTS");
  }

  const passwordHash = await hashPassword(password);

  const subject = await prisma.authSubject.create({
    data: {
      type: AuthSubjectType.ADMIN,
      admin: {
        create: {
          email,
          passwordHash,
          isActive: true,
        },
      },
    },
    include: { admin: true },
  });

  if (!subject.admin) {
    throw new Error("Failed to create admin credential");
  }

  const roles = await gatherAdminRoles({
    userService,
    subjectId: subject.id,
    logger,
  });

  const payload: AccessTokenPayload = {
    sub: subject.id,
    userType: "ADMIN",
    adminId: subject.id,
    roles,
  };

  return issueSessionTokens({
    prisma,
    redis,
    subjectId: subject.id,
    payload,
    signAccessToken,
  });
}

export async function authenticateCustomer(params: {
  prisma: PrismaClient;
  firebaseAuth: FirebaseAuthIntegration;
  firebaseToken: string;
  deviceId: string;
  guestId?: string;
  signAccessToken: (
    payload: AccessTokenPayload,
    expiresIn?: number
  ) => Promise<string>;
  userService: UserServiceIntegration;
  logger: FastifyBaseLogger;
  redis: Redis;
}): Promise<TokenResponse> {
  const {
    prisma,
    firebaseAuth,
    firebaseToken,
    deviceId,
    guestId,
    signAccessToken,
    userService,
    logger,
    redis,
  } = params;

  if (!userService.isEnabled) {
    throw new Error("UserService integration is required for customer login");
  }

  const decoded = await firebaseAuth.verifyIdToken(firebaseToken);
  const firebaseUid = decoded.uid;
  const phoneNumber = decoded.phone_number ?? undefined;

  const ensureResult = await userService.ensureCustomerProfile({
    firebaseUid,
    phoneNumber,
    deviceId,
    guestId,
  });

  const identity = await upsertCustomerSubject({
    prisma,
    firebaseUid,
    customerId: ensureResult.customerId,
  });

  if (ensureResult.guestProfileId) {
    const guestIdentity = await prisma.guestIdentity.findUnique({
      where: { guestProfileId: ensureResult.guestProfileId },
    });
    if (guestIdentity) {
      await prisma.guestIdentity.update({
        where: { guestProfileId: guestIdentity.guestProfileId },
        data: {
          status: GuestLifecycleStatus.MIGRATED,
          migratedToSubjectId: identity.subjectId,
          migratedAt: new Date(),
        },
      });
      await prisma.session.deleteMany({
        where: { subjectId: guestIdentity.subjectId },
      });
    }
  }

  const payload: AccessTokenPayload = {
    sub: identity.subjectId,
    userType: "CUSTOMER",
    userId: identity.customerId,
    firebaseUid: identity.firebaseUid,
    deviceId,
  };

  return issueSessionTokens({
    prisma,
    redis,
    subjectId: identity.subjectId,
    payload,
    signAccessToken,
    deviceId,
  });
}

export async function initializeGuest(params: {
  prisma: PrismaClient;
  deviceId: string;
  guestId?: string;
  signAccessToken: (
    payload: AccessTokenPayload,
    expiresIn?: number
  ) => Promise<string>;
  userService: UserServiceIntegration;
  redis: Redis;
}): Promise<{ guestId: string; tokens: TokenResponse }> {
  const {
    prisma,
    guestId: providedGuestId,
    deviceId,
    signAccessToken,
    userService,
    redis,
  } = params;

  if (!userService.isEnabled) {
    throw new Error("UserService integration is required for guest tokens");
  }

  const guestId = providedGuestId ?? randomUUID();

  const registration = await userService.registerGuest({
    guestId,
    deviceId,
  });

  if (registration.status === "MIGRATED") {
    throw new AuthError("Guest migrated to customer", "GUEST_MIGRATED");
  }

  const identity = await ensureGuestSubject({
    prisma,
    guestId,
    deviceId,
    guestProfileId: registration.guestProfileId,
  });

  const payload: AccessTokenPayload = {
    sub: identity.subjectId,
    userType: "GUEST",
    guestId,
    deviceId,
    guestProfileId: identity.guestProfileId,
  };

  const tokens = await issueSessionTokens({
    prisma,
    redis,
    subjectId: identity.subjectId,
    payload,
    signAccessToken,
    deviceId,
  });

  return { guestId, tokens };
}

export async function rotateRefreshToken(params: {
  prisma: PrismaClient;
  refreshToken: string;
  deviceId?: string;
  signAccessToken: (
    payload: AccessTokenPayload,
    expiresIn?: number
  ) => Promise<string>;
  userService: UserServiceIntegration;
  logger: FastifyBaseLogger;
  redis: Redis;
}): Promise<TokenResponse> {
  const {
    prisma,
    refreshToken,
    deviceId,
    signAccessToken,
    userService,
    logger,
    redis,
  } = params;

  const hashedToken = hashToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashedToken },
  });

  if (!session) {
    throw new AuthError("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } });
    throw new AuthError("Refresh token expired", "EXPIRED_REFRESH_TOKEN");
  }

  await prisma.session.delete({ where: { id: session.id } });

  const payload = await buildAccessPayload({
    prisma,
    subjectId: session.subjectId,
    userService,
    logger,
    deviceId: deviceId ?? session.deviceId ?? undefined,
  });

  if (payload.userType !== "ADMIN") {
    if (!session.deviceId) {
      throw new AuthError("Device mismatch", "DEVICE_MISMATCH");
    }
    if (
      (payload.userType === "CUSTOMER" || payload.userType === "GUEST") &&
      payload.deviceId !== session.deviceId
    ) {
      throw new AuthError("Device mismatch", "DEVICE_MISMATCH");
    }
  }

  return issueSessionTokens({
    prisma,
    redis,
    subjectId: session.subjectId,
    payload,
    signAccessToken,
    deviceId: session.deviceId ?? deviceId,
  });
}

export async function revokeSessions(params: {
  prisma: PrismaClient;
  subjectId: string;
  refreshToken?: string;
  deviceId?: string;
  allDevices?: boolean;
}): Promise<void> {
  const { prisma, subjectId, refreshToken, deviceId, allDevices } = params;

  if (allDevices) {
    await prisma.session.deleteMany({ where: { subjectId } });
    return;
  }

  await prisma.session.deleteMany({
    where: {
      subjectId,
      ...(refreshToken ? { refreshTokenHash: hashToken(refreshToken) } : {}),
      ...(deviceId ? { deviceId } : {}),
    },
  });
}

export async function verifyActiveSession(params: {
  redis: Redis;
  subjectId: string;
  sessionId: string;
}): Promise<boolean> {
  const { redis, subjectId, sessionId } = params;
  const key = `${ACTIVE_SESSION_PREFIX}${subjectId}`;
  const activeSessionId = await redis.get(key);

  console.log(`[VerifySession] checking key=${key}`);
  console.log(`[VerifySession] token.sessionId=${sessionId}`);
  console.log(`[VerifySession] redis.activeSessionId=${activeSessionId}`);

  return activeSessionId === sessionId;
}
