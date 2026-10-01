import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { getPrismaOptional } from "../lib/prisma";
import { getRedisOptional } from "../lib/redis";
import { audienceErrorHandler, mapTransportError } from "../plugins/audience-error-handler";
import { statusQuerySchema, zodIssuesToFields } from "../schemas/audience";
import { AudienceError } from "../services/audience-errors";
import {
  getBanner,
  getRegistrationStatus,
  MAX_PDF_BYTES,
  submitRegistration,
} from "../services/audience-registration-service";

const PHOTO_FIELD_RE = /^photo_(lead|member_([2-9]|10))$/;
// 10 images (5 MB) + 1 PDF (10 MB) + the JSON payload, with some headroom.
const MAX_REQUEST_BYTES = 62 * 1024 * 1024;

function requirePrisma() {
  const prisma = getPrismaOptional();
  if (!prisma) throw new AudienceError("SERVICE_UNAVAILABLE", "Service temporarily unavailable.");
  return prisma;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function audienceRoutes(app: FastifyInstance) {
  app.setErrorHandler(audienceErrorHandler);

  // Scoped to this plugin, so no other route in the service accepts multipart.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: MAX_PDF_BYTES, // largest allowed file; images are capped lower in the service
      files: 11,
      fields: 5,
      fieldSize: 256 * 1024,
      parts: 20,
    },
  });

  // GET /banner — public
  app.get("/banner", { config: { rawResponse: true } }, async (_request, reply) => {
    const body = await getBanner(requirePrisma());
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(body);
  });

  // GET /registration/status — the gateway sets x-user-id / x-user-type only
  // for a verified token. Guests have no phone, so they are treated as logged out.
  app.get("/registration/status", { config: { rawResponse: true } }, async (request, reply) => {
    const query = statusQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new AudienceError(
        "VALIDATION_FAILED",
        "Please fix the highlighted fields.",
        zodIssuesToFields(query.error.issues)
      );
    }
    const userType = singleHeader(request.headers["x-user-type"]);
    const userId =
      userType === "CUSTOMER" ? singleHeader(request.headers["x-user-id"]) : undefined;

    const body = await getRegistrationStatus({
      prisma: requirePrisma(),
      userId,
      mobileQuery: query.data.mobile,
    });
    reply.header("Cache-Control", "private, no-store");
    return reply.send(body);
  });

  // POST /registration — multipart/form-data
  app.post("/registration", { config: { rawResponse: true } }, async (request, reply) => {
    const prisma = requirePrisma();

    if (!request.isMultipart()) {
      throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
        payload: "Send the request as multipart/form-data",
      });
    }
    if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
      throw new AudienceError("FILE_TOO_LARGE", "The upload is too large.");
    }

    let payloadRaw: string | undefined;
    let groupPdf: Buffer | undefined;
    const photos = new Map<number, Buffer>();
    const seen = new Set<string>();
    let unexpectedField: string | undefined;

    try {
      for await (const part of request.parts()) {
        if (seen.has(part.fieldname)) {
          throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
            [part.fieldname]: "Sent more than once",
          });
        }
        seen.add(part.fieldname);

        if (part.type === "field") {
          if (part.fieldname === "payload") payloadRaw = String(part.value);
          continue;
        }

        // Always drain the stream (size-capped) so the request can finish.
        const buffer = await part.toBuffer();
        if (buffer.length === 0) continue; // empty placeholder part
        if (part.fieldname === "group_pdf") {
          groupPdf = buffer;
          continue;
        }
        const match = PHOTO_FIELD_RE.exec(part.fieldname);
        if (!match) {
          unexpectedField = part.fieldname;
          continue;
        }
        photos.set(match[1] === "lead" ? 1 : Number(match[2]), buffer);
      }
    } catch (err) {
      throw mapTransportError(err) ?? err;
    }

    if (unexpectedField) {
      throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
        files: "Unexpected file field in the upload",
      });
    }
    if (!payloadRaw) {
      throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
        payload: "payload is required",
      });
    }

    const userType = singleHeader(request.headers["x-user-type"]);
    const result = await submitRegistration({
      prisma,
      redis: getRedisOptional(),
      userId: userType === "CUSTOMER" ? singleHeader(request.headers["x-user-id"]) : undefined,
      idempotencyKey: singleHeader(request.headers["idempotency-key"]),
      payloadRaw,
      photos,
      groupPdf,
    });
    return reply.code(201).send(result);
  });
}
