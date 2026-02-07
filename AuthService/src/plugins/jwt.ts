import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { FastifyJWTOptions } from "@fastify/jwt";
import { loadConfig } from "../config";

export type AdminAccessTokenPayload = {
  sub: string;
  userType: "ADMIN";
  adminId: string;
  roles: string[];
  sessionId?: string;
};

export type CustomerAccessTokenPayload = {
  sub: string;
  userType: "CUSTOMER";
  userId: string;
  firebaseUid: string;
  deviceId: string;
  sessionId?: string;
};

export type GuestAccessTokenPayload = {
  sub: string;
  userType: "GUEST";
  guestId: string;
  deviceId: string;
  guestProfileId: string;
  sessionId?: string;
};

export type AccessTokenPayload =
  | AdminAccessTokenPayload
  | CustomerAccessTokenPayload
  | GuestAccessTokenPayload;

type JwtPayload = AccessTokenPayload & {
  iss: string;
  aud: string;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

async function jwtPlugin(fastify: FastifyInstance) {
  const config = loadConfig();

  const jwtPluginInstance = fastifyJwt as FastifyPluginAsync<FastifyJWTOptions>;

  const issuer = "auth-service";
  const audience = "pocketlol-services";

  await fastify.register(jwtPluginInstance, {
    secret: {
      private: config.AUTH_JWT_PRIVATE_KEY,
      public: config.AUTH_JWT_PUBLIC_KEY,
    },
    sign: {
      algorithm: "RS256",
      kid: config.AUTH_JWT_KEY_ID,
      iss: issuer,
      aud: audience,
    },
    verify: {
      algorithms: ["RS256"],
      allowedAud: audience,
      allowedIss: issuer,
    },
  });

  fastify.decorate(
    "signAccessToken",
    async (payload: AccessTokenPayload, expiresIn?: number) => {
      return fastify.jwt.sign(
        {
          ...payload,
          iss: issuer,
          aud: audience,
        },
        {
          expiresIn: expiresIn ?? config.ACCESS_TOKEN_TTL,
          kid: config.AUTH_JWT_KEY_ID,
        }
      );
    }
  );
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken(
      payload: AccessTokenPayload,
      expiresIn?: number
    ): Promise<string>;
  }
}

export default fp(jwtPlugin, {
  name: "jwt",
  dependencies: ["prisma"],
});
