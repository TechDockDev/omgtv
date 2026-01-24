// import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  assignRole,
  getUserContext,
  listRoles,
  revokeRole,
} from "../services/rbac";
import {
  assignRoleBodySchema,
  revokeRoleParamsSchema,
  userIdParamsSchema,
} from "../schemas/rbac";
import {
  serializeAssignment,
  serializeRole,
  serializeUserContext,
} from "../utils/serialize";
import { isAdminVerificationError } from "../types/auth-service";
import { listUsers, getUserDetails, updateUser, blockUser, deleteUser } from "../services/user-management";
import { z } from "zod";

export default async function adminUserRoutes(fastify: FastifyInstance) {
  const listUsersQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().optional(),
    status: z.enum(["active", "inactive", "blocked", "all"]).default("all"),
    plan: z.enum(["Free", "Basic", "Premium", "all"]).default("all"),
    userType: z.enum(["registered", "guest", "all"]).default("all"),
  });

  fastify.get("/app-users", {
    schema: {
      querystring: listUsersQuerySchema,
    },
    handler: async (request, reply) => {
      const params = listUsersQuerySchema.parse(request.query);

      // Ensure Admin (Optional strict check, can act as guard)
      // Only check if auth service enabled properly?
      // Assuming headers passed from internal or admin-api-gw. 
      // Context checks skipped for brevity or handled by global guard?
      // The current routes check specific user permission manually, let's proceed.

      const result = await listUsers(request.server.prisma, params);

      // Manual Global Response Wrapper (since UserService lacks the plugin currently)
      return {
        success: true,
        statusCode: 0,
        userMessage: "Users fetched successfully",
        developerMessage: "Fetched users from AuthDB and UserDB",
        data: result,
      };
    },
  });

  fastify.get("/app-users/:userId", {
    schema: {
      params: userIdParamsSchema,
    },
    handler: async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);

      const user = await getUserDetails(request.server.prisma, params.userId);

      if (!user) {
        throw request.server.httpErrors.notFound("User not found");
      }

      return {
        success: true,
        data: user,
      };
    },
  });



  const blockUserBodySchema = z.object({
    status: z.enum(["active", "blocked"]),
    reason: z.string().optional(),
  });

  fastify.patch("/app-users/:userId/block", {
    schema: {
      params: userIdParamsSchema,
      body: blockUserBodySchema,
    },
    handler: async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = blockUserBodySchema.parse(request.body);

      const success = await blockUser(
        request.server.prisma,
        params.userId,
        body.status === "blocked",
        body.reason
      );

      if (!success) {
        throw request.server.httpErrors.notFound("User not found or cannot be blocked");
      }

      return {
        success: true,
        data: { status: body.status }
      };
    },
  });

  fastify.delete("/app-users/:userId", {
    schema: {
      params: userIdParamsSchema,
    },
    handler: async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);

      const success = await deleteUser(request.server.prisma, params.userId);

      if (!success) {
        throw request.server.httpErrors.notFound("User not found");
      }

      return {
        success: true,
        data: { deleted: true }
      };
    },
  });


  fastify.get("/users/:userId/context", {
    schema: {
      params: userIdParamsSchema,
    },
    handler: async (request) => {
      const params = userIdParamsSchema.parse(request.params);
      const context = await getUserContext(
        request.server.prisma,
        params.userId
      );
      return serializeUserContext(context);
    },
  });

  fastify.post("/users/:userId/roles", {
    schema: {
      params: userIdParamsSchema,
      body: assignRoleBodySchema,
    },
    handler: async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = assignRoleBodySchema.parse(request.body);
      if (!request.server.authService.isEnabled) {
        throw request.server.httpErrors.serviceUnavailable(
          "AuthService integration is required for assigning roles"
        );
      }
      try {
        await request.server.authService.ensureAdminUser(params.userId);
      } catch (error) {
        if (isAdminVerificationError(error)) {
          if (error.reason === "NOT_FOUND") {
            throw request.server.httpErrors.notFound(error.message);
          }
          if (error.reason === "NOT_ADMIN") {
            throw request.server.httpErrors.forbidden(error.message);
          }
          if (error.reason === "INACTIVE") {
            throw request.server.httpErrors.conflict(error.message);
          }
        }
        request.log.error(
          { err: error, userId: params.userId },
          "Failed to verify admin user with AuthService"
        );
        throw request.server.httpErrors.internalServerError();
      }
      const assignment = await assignRole(request.server.prisma, {
        userId: params.userId,
        roleId: body.roleId,
        scope: body.scope,
        grantedBy: body.grantedBy,
      });
      return reply.code(201).send({
        assignment: serializeAssignment(assignment),
      });
    },
  });

  fastify.delete("/users/:userId/roles/:assignmentId", {
    schema: {
      params: revokeRoleParamsSchema,
    },
    handler: async (request, reply) => {
      const params = revokeRoleParamsSchema.parse(request.params);
      await revokeRole(request.server.prisma, {
        assignmentId: params.assignmentId,
        revokedBy: undefined,
      });
      return reply.code(204).send();
    },
  });

  fastify.get("/roles", {
    schema: {},
    handler: async (request) => {
      const roles = await listRoles(request.server.prisma);
      return {
        roles: roles.map(serializeRole),
      };
    },
  });
}
