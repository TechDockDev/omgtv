import { z } from "zod";

const permissionSchema = z
  .object({
    id: z.string().uuid(),
    resource: z.string(),
    action: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const roleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().optional(),
    isSystem: z.boolean(),
    permissions: z.array(permissionSchema).optional(),
  })
  .passthrough();

export const roleAssignmentSchema = z
  .object({
    assignmentId: z.string().uuid(),
    userId: z.string().uuid(),
    scope: z.string().optional(),
    grantedBy: z.string().optional(),
    active: z.boolean(),
    revokedAt: z.string().optional(),
    role: roleSchema,
  })
  .passthrough();

export const userContextSchema = z
  .object({
    userId: z.string().uuid(),
    roles: z.array(roleSchema),
    permissions: z.array(permissionSchema).optional(),
    assignments: z.array(roleAssignmentSchema),
  })
  .passthrough();

export type UserContextResponse = z.infer<typeof userContextSchema>;
