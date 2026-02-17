import type { FastifyInstance } from "fastify";
import adminCategoryRoutes from "./categories";
import adminSeriesRoutes from "./series";
import adminSeasonRoutes from "./seasons";
import adminEpisodeRoutes from "./episodes";
import adminTagRoutes from "./tags";
import adminReelRoutes from "./reels";
import adminCarouselRoutes from "./carousel";
import adminMediaRoutes from "./media";
import adminUploadRoutes from "./upload";
import adminImageRoutes from "./images";
import adminTopTenRoutes from "./top-ten";

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", async (request, reply) => {
    await fastify.verifyServiceRequest(request, reply);

    const rolesHeader =
      request.headers["x-admin-role"] ?? request.headers["x-user-roles"];

    const roles = Array.isArray(rolesHeader)
      ? rolesHeader
      : typeof rolesHeader === "string"
        ? rolesHeader
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean)
        : [];

    const userTypeHeader =
      typeof request.headers["x-user-type"] === "string"
        ? request.headers["x-user-type"]
        : "";

    const isAdminUserType = userTypeHeader.trim().toUpperCase() === "ADMIN";

    const isAdmin =
      isAdminUserType || roles.some((role) => role.toLowerCase() === "admin");

    if (!isAdmin) {
      throw reply.server.httpErrors.forbidden("Admin user required");
    }

    const adminId =
      (typeof request.headers["x-admin-id"] === "string"
        ? request.headers["x-admin-id"]
        : undefined) ??
      (typeof request.headers["x-user-id"] === "string"
        ? request.headers["x-user-id"]
        : undefined);

    if (!adminId) {
      throw reply.server.httpErrors.badRequest(
        "Missing admin identifier (x-admin-id or x-user-id)"
      );
    }

    request.headers["x-admin-id"] = adminId;
    request.log = request.log.child({
      adminId,
      admin: true,
      service: "content",
    });
  });

  await fastify.register(adminCategoryRoutes, {
    prefix: "/catalog/categories",
  });
  await fastify.register(adminSeriesRoutes, { prefix: "/catalog/series" });
  await fastify.register(adminSeasonRoutes, { prefix: "/catalog/seasons" });
  await fastify.register(adminEpisodeRoutes, { prefix: "/catalog/episodes" });
  await fastify.register(adminReelRoutes, { prefix: "/catalog/reels" });
  await fastify.register(adminTagRoutes, { prefix: "/catalog/tags" });
  await fastify.register(adminCarouselRoutes, {
    prefix: "/catalog/carousel",
  });
  await fastify.register(adminImageRoutes, { prefix: "/catalog/images" });

  // Register upload BEFORE media routes to avoid /:id collision
  fastify.register(adminUploadRoutes, { prefix: "/media" });
  fastify.register(adminMediaRoutes, { prefix: "/media" });
  await fastify.register(adminTopTenRoutes, { prefix: "/catalog/top-10" });
}
