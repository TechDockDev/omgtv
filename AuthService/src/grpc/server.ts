import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config";

type Server = grpc.Server;
type Metadata = grpc.Metadata;
const { ServerCredentials, status } = grpc;

const PROTO_PATH = path.join(__dirname, "../../proto/auth.proto");

type AuthPackageDefinition = ReturnType<typeof grpc.loadPackageDefinition> & {
  auth: {
    v1: {
      AuthService: grpc.ServiceClientConstructor & {
        service: grpc.ServiceDefinition;
      };
    };
  };
};

interface ValidateTokenRequest {
  access_token?: string;
}

interface ValidateTokenResponse {
  valid: boolean;
  user_id?: string;
  user_type?: string;
  role?: string;
  reason?: string;
}

interface GetUserByIdRequest {
  user_id?: string;
}

interface GetUserByIdResponse {
  user_id: string;
  email: string;
  role: string;
  active: boolean;
}

type UnaryHandler<Req, Res> = grpc.handleUnaryCall<Req, Res>;

const createServiceError = (
  code: grpc.status,
  message: string
): grpc.ServiceError => {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  return error;
};

function getAuthPackage(): AuthPackageDefinition["auth"]["v1"] {
  const packageDefinition = loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(
    packageDefinition
  ) as AuthPackageDefinition;
  return loaded.auth.v1;
}

function isAuthorized(metadata: Metadata, serviceToken?: string) {
  if (!serviceToken) {
    return true;
  }
  const header = metadata.get("authorization")[0];
  if (typeof header !== "string") {
    return false;
  }
  const token = header.replace(/^Bearer\s+/i, "");
  return token === serviceToken;
}

export async function startGrpcServer(params: {
  app: FastifyInstance;
  prisma: PrismaClient;
}): Promise<Server> {
  const config = loadConfig();
  const serviceToken = config.SERVICE_AUTH_TOKEN;
  const authPackage = getAuthPackage();
  const server = new grpc.Server();

  const validateToken: UnaryHandler<
    ValidateTokenRequest,
    ValidateTokenResponse
  > = async (call, callback) => {
    if (!isAuthorized(call.metadata, serviceToken)) {
      callback(createServiceError(status.PERMISSION_DENIED, "Unauthorized"));
      return;
    }
    const token = call.request.access_token;
    if (!token) {
      callback(null, {
        valid: false,
        reason: "ACCESS_TOKEN_REQUIRED",
      });
      return;
    }
    try {
      type AccessTokenPayload = {
        sub: string;
        userType: string;
        roles?: string[];
      };
      const decoded = await params.app.jwt.verify<AccessTokenPayload>(token);
      callback(null, {
        valid: true,
        user_id: decoded.sub,
        user_type: decoded.userType,
        role: decoded.userType,
      });
    } catch (error) {
      params.app.log.warn({ err: error }, "Token validation failed");
      callback(null, {
        valid: false,
        reason: "INVALID_TOKEN",
      });
    }
  };

  const getUserById: UnaryHandler<
    GetUserByIdRequest,
    GetUserByIdResponse
  > = async (call, callback) => {
    if (!isAuthorized(call.metadata, serviceToken)) {
      callback(createServiceError(status.PERMISSION_DENIED, "Unauthorized"));
      return;
    }
    const userId = call.request.user_id;
    if (!userId) {
      callback(
        createServiceError(status.INVALID_ARGUMENT, "user_id is required")
      );
      return;
    }
    try {
      const admin = await params.prisma.adminCredential.findUnique({
        where: { subjectId: userId },
      });
      if (!admin) {
        callback(createServiceError(status.NOT_FOUND, "User not found"));
        return;
      }
      callback(null, {
        user_id: admin.subjectId,
        email: admin.email,
        role: "ADMIN",
        active: admin.isActive,
      });
    } catch (error) {
      params.app.log.error({ err: error }, "Failed to fetch user by id");
      callback(createServiceError(status.INTERNAL, "Failed to fetch user"));
    }
  };

  server.addService(authPackage.AuthService.service, {
    ValidateToken: validateToken,
    GetUserById: getUserById,
  });

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      config.GRPC_BIND_ADDRESS,
      ServerCredentials.createInsecure(),
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });

  server.start();
  params.app.log.info(
    { bind: config.GRPC_BIND_ADDRESS },
    "gRPC server listening"
  );
  return server;
}

export async function stopGrpcServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.tryShutdown((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
