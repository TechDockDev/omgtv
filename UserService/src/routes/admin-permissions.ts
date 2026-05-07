import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config";

const idParamsSchema = z.object({ id: z.string().uuid() });
const roleIdParamsSchema = z.object({ roleId: z.string().uuid() });
const rolePermissionParamsSchema = z.object({
    roleId: z.string().uuid(),
    permissionId: z.string().uuid(),
});
const adminIdParamsSchema = z.object({ userId: z.string().uuid() });

export default async function adminPermissionsRoutes(fastify: FastifyInstance) {
    const config = loadConfig();

    const authServiceHeaders = () => {
        const h: Record<string, string> = { "content-type": "application/json" };
        if (config.SERVICE_AUTH_TOKEN) h["x-service-token"] = config.SERVICE_AUTH_TOKEN;
        return h;
    };

    const authServiceUrl = (config as any).AUTH_SERVICE_URL ?? "http://localhost:4000";

    // ─── Module Management ────────────────────────────────────────────────────

    /**
     * GET /admin/modules
     * List all modules (distinct resource values) with their permissions.
     */
    fastify.get("/modules", async () => {
        const permissions = await fastify.prisma.permission.findMany({
            orderBy: [{ resource: "asc" }, { action: "asc" }],
        });

        const moduleMap = new Map<string, { resource: string; permissions: typeof permissions }>();
        for (const p of permissions) {
            if (!moduleMap.has(p.resource)) {
                moduleMap.set(p.resource, { resource: p.resource, permissions: [] });
            }
            moduleMap.get(p.resource)!.permissions.push(p);
        }

        return { modules: Array.from(moduleMap.values()) };
    });

    /**
     * POST /admin/modules
     * Create a module and optionally auto-generate view/create/update/delete permissions.
     */
    fastify.post("/modules", async (request, reply) => {
        const body = z.object({
            name: z.string().min(1).regex(/^[a-z0-9_]+$/),
            description: z.string().optional(),
            autoGenerate: z.boolean().default(false),
        }).parse(request.body);

        const actions = body.autoGenerate ? ["view", "create", "update", "delete"] : [];
        const created: any[] = [];

        for (const action of actions) {
            try {
                const p = await fastify.prisma.permission.create({
                    data: {
                        resource: body.name,
                        action,
                        description: body.description ? `${body.description} — ${action}` : undefined,
                    },
                });
                created.push(p);
            } catch {
                // skip if duplicate
            }
        }

        return reply.code(201).send({ resource: body.name, created });
    });

    /**
     * DELETE /admin/modules/:resource
     * Delete a module and all its permissions (blocked if any role uses them).
     */
    fastify.delete("/modules/:resource", async (request, reply) => {
        const { resource } = z.object({ resource: z.string() }).parse(request.params);

        const permissions = await fastify.prisma.permission.findMany({ where: { resource } });
        const permIds = permissions.map((p) => p.id);

        const inUse = await fastify.prisma.rolePermission.count({
            where: { permissionId: { in: permIds } },
        });
        if (inUse > 0) {
            return reply.code(409).send({ error: "Module permissions are assigned to roles. Unassign first." });
        }

        await fastify.prisma.permission.deleteMany({ where: { resource } });
        return { deleted: permIds.length };
    });

    // ─── Permission CRUD ──────────────────────────────────────────────────────

    /**
     * GET /admin/permissions
     * List all permissions grouped by resource/module.
     */
    fastify.get("/permissions", async () => {
        const permissions = await fastify.prisma.permission.findMany({
            orderBy: [{ resource: "asc" }, { action: "asc" }],
        });
        return { permissions };
    });

    /**
     * POST /admin/permissions
     * Create a single permission.
     */
    fastify.post("/permissions", async (request, reply) => {
        const body = z.object({
            resource: z.string().min(1),
            action: z.string().min(1),
            description: z.string().optional(),
        }).parse(request.body);

        const existing = await fastify.prisma.permission.findUnique({
            where: { resource_action: { resource: body.resource, action: body.action } },
        });
        if (existing) {
            return reply.code(409).send({ error: "Permission already exists" });
        }

        const permission = await fastify.prisma.permission.create({ data: body });
        return reply.code(201).send({ permission });
    });

    /**
     * PATCH /admin/permissions/:id
     * Update description of a permission.
     */
    fastify.patch("/permissions/:id", async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const body = z.object({ description: z.string() }).parse(request.body);

        const permission = await fastify.prisma.permission.findUnique({ where: { id } });
        if (!permission) return reply.code(404).send({ error: "Permission not found" });

        const updated = await fastify.prisma.permission.update({ where: { id }, data: body });
        return { permission: updated };
    });

    /**
     * DELETE /admin/permissions/:id
     * Delete permission (blocked if assigned to any role).
     */
    fastify.delete("/permissions/:id", async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);

        const inUse = await fastify.prisma.rolePermission.count({ where: { permissionId: id } });
        if (inUse > 0) {
            return reply.code(409).send({ error: "Permission is assigned to roles. Unassign first." });
        }

        await fastify.prisma.permission.delete({ where: { id } });
        return { deleted: true };
    });

    // ─── Role CRUD ────────────────────────────────────────────────────────────

    /**
     * GET /admin/roles/:roleId
     * Get single role with full permission list.
     */
    fastify.get("/roles/:roleId", async (request, reply) => {
        const { roleId } = roleIdParamsSchema.parse(request.params);
        const role = await fastify.prisma.role.findUnique({
            where: { id: roleId },
            include: { permissions: { include: { permission: true } } },
        });
        if (!role) return reply.code(404).send({ error: "Role not found" });
        return { role: { ...role, permissions: role.permissions.map((rp) => rp.permission) } };
    });

    /**
     * POST /admin/roles
     * Create a custom role.
     */
    fastify.post("/roles", async (request, reply) => {
        const body = z.object({
            name: z.string().min(1).toUpperCase(),
            description: z.string().optional(),
        }).parse(request.body);

        const existing = await fastify.prisma.role.findUnique({ where: { name: body.name } });
        if (existing) return reply.code(409).send({ error: "Role name already exists" });

        const role = await fastify.prisma.role.create({
            data: { name: body.name, description: body.description, isSystem: false },
        });
        return reply.code(201).send({ role });
    });

    /**
     * PATCH /admin/roles/:roleId
     * Update role name/description (blocked if isSystem).
     */
    fastify.patch("/roles/:roleId", async (request, reply) => {
        const { roleId } = roleIdParamsSchema.parse(request.params);
        const body = z.object({
            name: z.string().min(1).optional(),
            description: z.string().optional(),
        }).parse(request.body);

        const role = await fastify.prisma.role.findUnique({ where: { id: roleId } });
        if (!role) return reply.code(404).send({ error: "Role not found" });
        if (role.isSystem) return reply.code(403).send({ error: "Cannot modify system roles" });

        const updated = await fastify.prisma.role.update({ where: { id: roleId }, data: body });
        return { role: updated };
    });

    /**
     * DELETE /admin/roles/:roleId
     * Delete role (blocked if isSystem or has active assignments).
     */
    fastify.delete("/roles/:roleId", async (request, reply) => {
        const { roleId } = roleIdParamsSchema.parse(request.params);

        const role = await fastify.prisma.role.findUnique({ where: { id: roleId } });
        if (!role) return reply.code(404).send({ error: "Role not found" });
        if (role.isSystem) return reply.code(403).send({ error: "Cannot delete system roles" });

        const activeAssignments = await fastify.prisma.userRoleAssignment.count({
            where: { roleId, isActive: true },
        });
        if (activeAssignments > 0) {
            return reply.code(409).send({ error: "Role has active assignments. Revoke them first." });
        }

        await fastify.prisma.role.delete({ where: { id: roleId } });
        return { deleted: true };
    });

    // ─── Role ↔ Permission Matrix ─────────────────────────────────────────────

    /**
     * PUT /admin/roles/:roleId/permissions
     * Replace the full permission set of a role.
     */
    fastify.put("/roles/:roleId/permissions", async (request, reply) => {
        const { roleId } = roleIdParamsSchema.parse(request.params);
        const { permissionIds } = z.object({ permissionIds: z.array(z.string().uuid()) }).parse(request.body);

        const role = await fastify.prisma.role.findUnique({ where: { id: roleId } });
        if (!role) return reply.code(404).send({ error: "Role not found" });

        await fastify.prisma.$transaction(async (tx) => {
            await tx.rolePermission.deleteMany({ where: { roleId } });
            if (permissionIds.length > 0) {
                await tx.rolePermission.createMany({
                    data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
                    skipDuplicates: true,
                });
            }
        });

        const updated = await fastify.prisma.role.findUnique({
            where: { id: roleId },
            include: { permissions: { include: { permission: true } } },
        });
        return { role: { ...updated, permissions: updated!.permissions.map((rp) => rp.permission) } };
    });

    /**
     * POST /admin/roles/:roleId/permissions/:permissionId
     * Add one permission to a role.
     */
    fastify.post("/roles/:roleId/permissions/:permissionId", async (request, reply) => {
        const { roleId, permissionId } = rolePermissionParamsSchema.parse(request.params);

        const [role, permission] = await Promise.all([
            fastify.prisma.role.findUnique({ where: { id: roleId } }),
            fastify.prisma.permission.findUnique({ where: { id: permissionId } }),
        ]);
        if (!role) return reply.code(404).send({ error: "Role not found" });
        if (!permission) return reply.code(404).send({ error: "Permission not found" });

        await fastify.prisma.rolePermission.upsert({
            where: { roleId_permissionId: { roleId, permissionId } },
            create: { roleId, permissionId },
            update: {},
        });

        return reply.code(201).send({ success: true });
    });

    /**
     * DELETE /admin/roles/:roleId/permissions/:permissionId
     * Remove one permission from a role.
     */
    fastify.delete("/roles/:roleId/permissions/:permissionId", async (request, reply) => {
        const { roleId, permissionId } = rolePermissionParamsSchema.parse(request.params);

        const assignment = await fastify.prisma.rolePermission.findUnique({
            where: { roleId_permissionId: { roleId, permissionId } },
        });
        if (!assignment) return reply.code(404).send({ error: "Permission not assigned to this role" });

        await fastify.prisma.rolePermission.delete({
            where: { roleId_permissionId: { roleId, permissionId } },
        });
        return { deleted: true };
    });

    // ─── Admin User Management ────────────────────────────────────────────────

    /**
     * GET /admin/admins
     * List all admin users with their roles.
     */
    fastify.get("/admins", async () => {
        const profiles = await fastify.prisma.adminProfile.findMany({
            orderBy: { createdAt: "desc" },
        });

        const profilesWithRoles = await Promise.all(
            profiles.map(async (profile) => {
                const assignments = await fastify.prisma.userRoleAssignment.findMany({
                    where: { userId: profile.subjectId, isActive: true },
                    include: { role: true },
                });
                return {
                    ...profile,
                    roles: assignments.map((a) => a.role),
                };
            })
        );

        return { admins: profilesWithRoles };
    });

    /**
     * POST /admin/admins
     * Create a new admin account with optional role assignment.
     */
    fastify.post("/admins", async (request, reply) => {
        const body = z.object({
            email: z.string().email(),
            password: z.string().min(6),
            name: z.string().optional(),
            roleId: z.string().uuid().optional(),
        }).parse(request.body);

        // Call AuthService internal endpoint to create the credential
        const provisionRes = await fetch(`${authServiceUrl}/internal/admin/provision`, {
            method: "POST",
            headers: authServiceHeaders(),
            body: JSON.stringify({ email: body.email, password: body.password }),
        });

        if (!provisionRes.ok) {
            const err = await provisionRes.json().catch(() => ({ error: "Unknown error" }));
            return reply.code(provisionRes.status).send(err);
        }

        const { subjectId } = await provisionRes.json() as { subjectId: string };

        // Create AdminProfile in UserService DB
        const profile = await fastify.prisma.adminProfile.create({
            data: { subjectId, name: body.name },
        });

        // Assign role if provided
        if (body.roleId) {
            const role = await fastify.prisma.role.findUnique({ where: { id: body.roleId } });
            if (role) {
                await fastify.prisma.userRoleAssignment.create({
                    data: { userId: subjectId, roleId: body.roleId },
                });
            }
        }

        return reply.code(201).send({ admin: { ...profile, subjectId } });
    });

    /**
     * GET /admin/admins/:userId
     * Get admin profile + role assignments.
     */
    fastify.get("/admins/:userId", async (request, reply) => {
        const { userId } = adminIdParamsSchema.parse(request.params);

        const profile = await fastify.prisma.adminProfile.findUnique({ where: { subjectId: userId } });
        if (!profile) return reply.code(404).send({ error: "Admin not found" });

        const assignments = await fastify.prisma.userRoleAssignment.findMany({
            where: { userId, isActive: true },
            include: { role: { include: { permissions: { include: { permission: true } } } } },
        });

        return {
            admin: {
                ...profile,
                roles: assignments.map((a) => ({
                    ...a.role,
                    permissions: a.role.permissions.map((rp) => rp.permission),
                })),
            },
        };
    });

    /**
     * PATCH /admin/admins/:userId
     * Update admin profile (name, etc.).
     */
    fastify.patch("/admins/:userId", async (request, reply) => {
        const { userId } = adminIdParamsSchema.parse(request.params);
        const body = z.object({
            name: z.string().optional(),
            bio: z.string().optional(),
            phoneNumber: z.string().optional(),
        }).parse(request.body);

        const profile = await fastify.prisma.adminProfile.findUnique({ where: { subjectId: userId } });
        if (!profile) return reply.code(404).send({ error: "Admin not found" });

        const updated = await fastify.prisma.adminProfile.update({
            where: { subjectId: userId },
            data: body,
        });
        return { admin: updated };
    });

    /**
     * DELETE /admin/admins/:userId
     * Deactivate admin account (disable credential via AuthService).
     */
    fastify.delete("/admins/:userId", async (request, reply) => {
        const { userId } = adminIdParamsSchema.parse(request.params);

        const profile = await fastify.prisma.adminProfile.findUnique({ where: { subjectId: userId } });
        if (!profile) return reply.code(404).send({ error: "Admin not found" });

        const deactivateRes = await fetch(`${authServiceUrl}/internal/admin/${userId}/active`, {
            method: "PATCH",
            headers: authServiceHeaders(),
            body: JSON.stringify({ isActive: false }),
        });

        if (!deactivateRes.ok) {
            return reply.code(502).send({ error: "Failed to deactivate admin in AuthService" });
        }

        return { deactivated: true };
    });

    /**
     * POST /admin/admins/:userId/reset-password
     * Reset admin password.
     */
    fastify.post("/admins/:userId/reset-password", async (request, reply) => {
        const { userId } = adminIdParamsSchema.parse(request.params);
        const { password } = z.object({ password: z.string().min(6) }).parse(request.body);

        const profile = await fastify.prisma.adminProfile.findUnique({ where: { subjectId: userId } });
        if (!profile) return reply.code(404).send({ error: "Admin not found" });

        const resetRes = await fetch(`${authServiceUrl}/internal/admin/${userId}/reset-password`, {
            method: "POST",
            headers: authServiceHeaders(),
            body: JSON.stringify({ password }),
        });

        if (!resetRes.ok) {
            return reply.code(502).send({ error: "Failed to reset password in AuthService" });
        }

        return { success: true };
    });
}
