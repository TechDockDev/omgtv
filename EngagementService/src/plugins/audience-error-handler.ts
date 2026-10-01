import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AudienceError, toErrorBody } from "../services/audience-errors";

/** Translates @fastify/multipart / Fastify transport errors into contract errors. */
export function mapTransportError(err: unknown): AudienceError | null {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "FST_REQ_FILE_TOO_LARGE":
      return new AudienceError("FILE_TOO_LARGE", "A file is larger than the allowed size.");
    case "FST_FILES_LIMIT":
    case "FST_PARTS_LIMIT":
    case "FST_FIELDS_LIMIT":
      return new AudienceError("VALIDATION_FAILED", "Too many files or fields were sent.");
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AudienceError("VALIDATION_FAILED", "Send the request as multipart/form-data.");
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return new AudienceError("FILE_TOO_LARGE", "The request is too large.");
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return new AudienceError("UNSUPPORTED_FILE", "Unsupported content type.");
    default:
      return null;
  }
}

// Installed per plugin scope so only audience routes get the raw error shape.
export function audienceErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const mapped = error instanceof AudienceError ? error : mapTransportError(error);
  if (mapped) {
    return reply.code(mapped.httpStatus).send(toErrorBody(mapped));
  }
  // Log only the error class/code: messages from the DB layer can embed
  // submitted values, and registrations are full of personal data.
  request.log.error(
    { errName: error.name, errCode: (error as { code?: string }).code },
    "audience request failed"
  );
  const internal = new AudienceError("INTERNAL_ERROR", "Something went wrong. Please try again.");
  return reply.code(internal.httpStatus).send(toErrorBody(internal));
}
