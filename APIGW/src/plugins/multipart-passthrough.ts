import type { FastifyInstance } from "fastify";

export const MULTIPART_MAX_BYTES = 64 * 1024 * 1024;
export const MULTIPART_ALLOWED_PREFIX = "/api/v1/audience/";

// multipart/form-data is only accepted for the audience registration upload.
// The request stream is handed through untouched (never buffered here) so
// @fastify/reply-from can forward it to the service, which enforces the
// per-file limits. We only cap the declared size and require a length so an
// endless chunked upload can't tie up the gateway.
export function registerMultipartPassthrough(app: FastifyInstance) {
  app.addContentTypeParser("multipart/form-data", (request, payload, done) => {
    const reject = (statusCode: number, message: string) => {
      const err = new Error(message) as Error & { statusCode: number };
      err.statusCode = statusCode;
      done(err, undefined);
    };
    if (!request.url.startsWith(MULTIPART_ALLOWED_PREFIX)) {
      reject(415, "multipart/form-data is not accepted on this route");
      return;
    }
    const length = Number(request.headers["content-length"]);
    if (!Number.isFinite(length) || length <= 0) {
      reject(411, "Content-Length is required for uploads");
      return;
    }
    if (length > MULTIPART_MAX_BYTES) {
      reject(413, "Upload is too large");
      return;
    }
    done(null, payload);
  });
}
