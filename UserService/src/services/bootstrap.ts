import type { PrismaClient } from "@prisma/client";

const SYSTEM_ROLES = [
  { name: "SUPER_ADMIN", description: "Unrestricted access to everything. Manages all modules, permissions, and roles via Permission Center." },
  { name: "ADMIN",       description: "Operational administrator. SUPER_ADMIN assigns specific permissions from Permission Center." },
];

const REMOVED_ROLES = ["FINANCE_MANAGER", "CONTENT_MANAGER", "RIA", "FINANCIAL_TEAM"];

export async function ensureSystemRoles(prisma: PrismaClient): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const existing = await prisma.role.findUnique({ where: { name: role.name } });
    if (existing) {
      await prisma.role.update({
        where: { id: existing.id },
        data: { isSystem: true, description: role.description },
      });
    } else {
      await prisma.role.create({
        data: { name: role.name, description: role.description, isSystem: true },
      });
    }
  }

  // Remove legacy system roles no longer needed
  for (const name of REMOVED_ROLES) {
    const role = await prisma.role.findUnique({ where: { name } });
    if (!role) continue;
    await prisma.userRoleAssignment.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.role.delete({ where: { id: role.id } });
  }
}
