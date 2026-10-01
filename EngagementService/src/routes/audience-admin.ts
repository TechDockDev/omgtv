import type { FastifyInstance } from "fastify";
import { getPrismaOptional } from "../lib/prisma";
import { audienceErrorHandler } from "../plugins/audience-error-handler";
import {
  adminConfigBodySchema,
  adminListQuerySchema,
  adminStatusBodySchema,
  emailTemplateImageBodySchema,
  zodIssuesToFields,
} from "../schemas/audience";
import { AudienceError } from "../services/audience-errors";
import {
  exportRegistrationsCsv,
  getAdminConfig,
  getEmailTemplateImage,
  getRegistrationDetail,
  listRegistrations,
  updateAdminConfig,
  updateEmailTemplateImage,
  updateRegistrationStatus,
} from "../services/audience-admin-service";
import { getAudienceStorage } from "../services/audience-storage";
import { z } from "zod";

const idParamsSchema = z.object({ id: z.string().uuid("Invalid registration id") });

function requirePrisma() {
  const prisma = getPrismaOptional();
  if (!prisma) throw new AudienceError("SERVICE_UNAVAILABLE", "Service temporarily unavailable.");
  return prisma;
}

function parseOrThrow<T>(result: z.SafeParseReturnType<unknown, T>): T {
  if (!result.success) {
    throw new AudienceError(
      "VALIDATION_FAILED",
      "Please fix the highlighted fields.",
      zodIssuesToFields(result.error.issues)
    );
  }
  return result.data;
}

// Mounted under /admin/audience. Only the gateway reaches this service, and it
// only forwards these paths for admin tokens (same trust model as /admin/*).
export default async function audienceAdminRoutes(app: FastifyInstance) {
  app.setErrorHandler(audienceErrorHandler);
  const raw = { config: { rawResponse: true } };

  const adminId = (headers: Record<string, unknown>) => {
    const value = headers["x-user-id"];
    return typeof value === "string" ? value : undefined;
  };

  app.get("/config", raw, async () => getAdminConfig(requirePrisma()));

  app.patch("/config", raw, async (request) => {
    const body = parseOrThrow(adminConfigBodySchema.safeParse(request.body));
    return updateAdminConfig(requirePrisma(), adminId(request.headers), body);
  });

  app.get("/registrations", raw, async (request) => {
    const query = parseOrThrow(adminListQuerySchema.safeParse(request.query));
    return listRegistrations(requirePrisma(), query);
  });

  // Declared before /:id; Fastify prefers the static segment either way.
  app.get("/registrations/export", raw, async (request, reply) => {
    const query = parseOrThrow(adminListQuerySchema.omit({ page: true, limit: true }).safeParse(request.query));
    const csv = await exportRegistrationsCsv(requirePrisma(), query);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="audience-registrations-${stamp}.csv"`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(csv);
  });

  app.get("/registrations/:id", raw, async (request) => {
    const { id } = parseOrThrow(idParamsSchema.safeParse(request.params));
    return getRegistrationDetail(requirePrisma(), id, getAudienceStorage());
  });

  app.patch("/registrations/:id/status", raw, async (request) => {
    const { id } = parseOrThrow(idParamsSchema.safeParse(request.params));
    const { status } = parseOrThrow(adminStatusBodySchema.safeParse(request.body));
    return updateRegistrationStatus(requirePrisma(), id, status);
  });

  // GET/PATCH /email-template/image — the image used inside confirmation and
  // status-change emails. Admin pastes an already-hosted URL (media library),
  // same pattern as banner_image_url — no upload here.
  app.get("/email-template/image", raw, async () => getEmailTemplateImage(requirePrisma()));

  app.patch("/email-template/image", raw, async (request) => {
    const { email_banner_image_url } = parseOrThrow(emailTemplateImageBodySchema.safeParse(request.body));
    return updateEmailTemplateImage(requirePrisma(), adminId(request.headers), email_banner_image_url);
  });
}
