import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { request, type Dispatcher } from "undici";
import type { GatewayUser } from "../types";
import { loadConfig, type AppConfig } from "../config";

export class UpstreamServiceError extends Error {
  constructor(
    message: string,
    public readonly service: string,
    public readonly statusCode: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "UpstreamServiceError";
  }
}

interface ServiceRequestOptions {
  serviceName: string;
  baseUrl: string;
  path: string;
  method: Dispatcher.HttpMethod;
  correlationId: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  user?: GatewayUser;
  headers?: Record<string, string>;
  timeoutMs?: number;
  parentSpan?: Span;
  spanName?: string;
}

interface JsonResponse<T> {
  statusCode: number;
  payload: T;
}

const DEFAULT_TIMEOUT = 5_000;

function buildUrl(
  baseUrl: string,
  path: string,
  query?: ServiceRequestOptions["query"]
) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, baseUrl);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (typeof value === "undefined" || value === null) {
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url;
}

function buildHeaders(options: ServiceRequestOptions, config: AppConfig) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-correlation-id": options.correlationId,
    ...options.headers,
  };

  if (options.user) {
    headers["x-user-id"] = options.user.id;
    headers["x-user-roles"] = options.user.roles.join(",");
    headers["x-user-type"] = options.user.userType;
  }

  if (config.SERVICE_AUTH_TOKEN) {
    if (!("authorization" in headers)) {
      headers.authorization = `Bearer ${config.SERVICE_AUTH_TOKEN}`;
    }
    headers["x-service-token"] = config.SERVICE_AUTH_TOKEN;
  }

  return headers;
}

export async function performServiceRequest<T = unknown>(
  options: ServiceRequestOptions
): Promise<JsonResponse<T>> {
  const config = loadConfig();
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const headers = buildHeaders(options, config);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
  let body: Dispatcher.DispatchOptions["body"] | undefined;
  if (typeof options.body === "undefined") {
    body = undefined;
  } else if (
    typeof options.body === "string" ||
    options.body instanceof Uint8Array
  ) {
    body = options.body;
  } else {
    body = JSON.stringify(options.body);
  }

  const sanitizedUrl = `${url.origin}${url.pathname}`;

  const execute = async (span?: Span): Promise<JsonResponse<T>> => {
    span?.setAttributes({
      "http.method": options.method,
      "http.url": sanitizedUrl,
      "http.target": `${url.pathname}${url.search}`,
      "net.peer.name": url.hostname,
      "gateway.upstream.service": options.serviceName,
      "http.request.timeout_ms": timeout,
    });

    try {
      const response = await request(url, {
        method: options.method,
        headers,
        body,
        headersTimeout: timeout,
        bodyTimeout: timeout,
      });

      span?.setAttribute("http.status_code", response.statusCode);

      if (response.statusCode >= 400) {
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.statusCode}`,
        });

        let errorBody: unknown;
        try {
          errorBody = await response.body.json();
        } catch {
          errorBody = await response.body.text();
        }

        throw new UpstreamServiceError(
          `Upstream ${options.serviceName} error: HTTP ${response.statusCode}`,
          options.serviceName,
          response.statusCode,
          errorBody
        );
      }

      span?.setStatus({ code: SpanStatusCode.OK });

      if (response.statusCode === 204) {
        return {
          statusCode: response.statusCode,
          payload: undefined as T,
        };
      }

      const payload = (await response.body.json()) as T;
      return {
        statusCode: response.statusCode,
        payload,
      };
    } catch (error) {
      if (span) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            error instanceof Error ? error.message : "Upstream request failed",
        });
      }
      throw error;
    } finally {
      span?.end();
    }
  };

  if (!config.ENABLE_TELEMETRY || !config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return execute();
  }

  const tracer = trace.getTracer(config.SERVICE_NAME);
  const parentContext = options.parentSpan
    ? trace.setSpan(context.active(), options.parentSpan)
    : context.active();
  const span = tracer.startSpan(
    options.spanName ?? `proxy:${options.serviceName}`,
    {
      kind: SpanKind.CLIENT,
    },
    parentContext
  );

  return context.with(trace.setSpan(parentContext, span), () => execute(span));
}
