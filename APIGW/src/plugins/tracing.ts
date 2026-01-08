import fp from "fastify-plugin";
import { randomUUID } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { loadConfig } from "../config";
import { initializeTelemetry, shutdownTelemetry } from "../observability/otel";

const CORRELATION_HEADER = "x-correlation-id";

function ensureCorrelationId(request: FastifyRequest) {
  const incoming =
    request.headers[CORRELATION_HEADER] ?? request.headers["x-request-id"];
  const correlationId = Array.isArray(incoming) ? incoming[0] : incoming;
  request.correlationId =
    correlationId && correlationId.length > 0 ? correlationId : randomUUID();
}

function attachCorrelationHeader(reply: FastifyReply) {
  reply.header(CORRELATION_HEADER, reply.request.correlationId);
}

export default fp(
  async function tracingPlugin(fastify) {
    const config = loadConfig();
    const telemetryEnabled = Boolean(config.ENABLE_TELEMETRY);
    const telemetryReady = Boolean(
      config.ENABLE_TELEMETRY && config.OTEL_EXPORTER_OTLP_ENDPOINT
    );

    fastify.decorateRequest("correlationId", "");

    if (telemetryEnabled) {
      await initializeTelemetry(config, fastify.log);
      fastify.addHook("onClose", async () => {
        await shutdownTelemetry(fastify.log);
      });
    }

    fastify.addHook("onRequest", async (request) => {
      ensureCorrelationId(request);

      if (!telemetryReady) {
        return;
      }

      const tracer = trace.getTracer(config.SERVICE_NAME);
      const span = tracer.startSpan(`HTTP ${request.method} ${request.url}`, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.method": request.method,
          "http.target": request.url,
          "http.scheme": request.protocol,
          "http.host": request.headers.host ?? "",
          "http.request.header.x-correlation-id": request.correlationId,
        },
      });

      request.telemetrySpan = span;
    });

    fastify.addHook("preHandler", async (request) => {
      if (!request.telemetrySpan) {
        return;
      }

      const route = request.routeOptions.url ?? request.url;
      request.telemetrySpan.setAttribute("http.route", route);
      request.telemetrySpan.updateName(`HTTP ${request.method} ${route}`);
    });

    fastify.addHook("onSend", async (request, reply) => {
      attachCorrelationHeader(reply);

      if (!request.telemetrySpan) {
        return;
      }

      request.telemetrySpan.setAttribute("http.status_code", reply.statusCode);

      if (reply.statusCode >= 500) {
        request.telemetrySpan.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        request.telemetrySpan.setStatus({ code: SpanStatusCode.OK });
      }
    });

    fastify.addHook("onResponse", async (request) => {
      request.telemetrySpan?.end();
    });

    fastify.addHook("onError", async (request, reply, error) => {
      if (request.telemetrySpan) {
        request.telemetrySpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        request.telemetrySpan.recordException(error);
      }
      attachCorrelationHeader(reply);
    });
  },
  { name: "tracing" }
);

declare module "fastify" {
  interface FastifyRequest {
    telemetrySpan?: import("@opentelemetry/api").Span;
  }
}
