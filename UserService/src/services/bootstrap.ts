import type { PrismaClient } from "@prisma/client";

// Only system role names are seeded. Permissions and assignments are fully
// managed by SUPER_ADMIN from the Permission Center UI — nothing is hardcoded here.
// SUPER_ADMIN bypasses all permission checks at the middleware level.
const SYSTEM_ROLES = [
  { name: "SUPER_ADMIN",      description: "Unrestricted access to everything. Manages all modules, permissions, and roles via Permission Center." },
  { name: "ADMIN",            description: "Operational administrator. SUPER_ADMIN assigns specific permissions from Permission Center." },
  { name: "FINANCE_MANAGER",  description: "Finance and billing role. SUPER_ADMIN assigns specific permissions from Permission Center." },
  { name: "CONTENT_MANAGER",  description: "Content catalog role. SUPER_ADMIN assigns specific permissions from Permission Center." },
];

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
}
