import type { FastifyRequest, FastifyReply } from "fastify";

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = (request.headers["x-user-permissions"] as string) ?? "";
    const roles = (request.headers["x-user-roles"] as string) ?? "";
    if (roles.split(",").map((r) => r.trim()).includes("SUPER_ADMIN")) return;
    const granted = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (!granted.includes(permission)) {
      return reply.code(403).send({ error: `Missing permission: ${permission}` });
    }
  };
}
