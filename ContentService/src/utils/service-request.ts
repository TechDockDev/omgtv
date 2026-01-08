import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { request, type Dispatcher } from "undici";
import { loadConfig } from "../config";

type JsonRecord = Record<string, string | number | boolean | undefined>;

export type ServiceRequestOptions = {
  serviceName: string;
  baseUrl: string;
  path: string;
  method: Dispatcher.HttpMethod;
  query?: JsonRecord;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  correlationId?: string;
  spanName?: string;
};

export type ServiceRequestResult<T> = {
  statusCode: number;
  payload: T;
};

export class ServiceRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ServiceRequestError";
  }
}

const tracer = trace.getTracer("content-service.clients");
const DEFAULT_TIMEOUT_MS = 5_000;

function buildUrl(baseUrl: string, path: string, query?: JsonRecord) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "undefined" || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildHeaders(options: ServiceRequestOptions) {
  const config = loadConfig();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };

  if (options.correlationId) {
    headers["x-correlation-id"] = options.correlationId;
  }

  if (config.SERVICE_AUTH_TOKEN) {
    headers.authorization =
      headers.authorization ?? `Bearer ${config.SERVICE_AUTH_TOKEN}`;
    headers["x-service-token"] = config.SERVICE_AUTH_TOKEN;
  }

  return headers;
}

export async function performServiceRequest<T = unknown>(
  options: ServiceRequestOptions
): Promise<ServiceRequestResult<T>> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const headers = buildHeaders(options);
  const timeout =
    options.timeoutMs ??
    loadConfig().SERVICE_REQUEST_TIMEOUT_MS ??
    DEFAULT_TIMEOUT_MS;
  const body =
    typeof options.body === "string" || options.body instanceof Uint8Array
      ? options.body
      : typeof options.body === "undefined"
        ? undefined
        : JSON.stringify(options.body);

  const sanitizedUrl = `${url.origin}${url.pathname}`;
  const span = tracer.startSpan(
    options.spanName ?? `client:${options.serviceName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.method": options.method,
        "http.url": sanitizedUrl,
        "http.target": `${url.pathname}${url.search}`,
        "net.peer.name": url.hostname,
        "service.request.timeout_ms": timeout,
        "service.request.name": options.serviceName,
      },
    }
  );

  try {
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        const response = await request(url, {
          method: options.method,
          headers,
          body,
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });

        span.setAttribute("http.status_code", response.statusCode);

        if (response.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.statusCode}`,
          });

          let errorPayload: unknown;
          try {
            errorPayload = await response.body.json();
          } catch {
            errorPayload = await response.body.text();
          }

          throw new ServiceRequestError(
            `Upstream ${options.serviceName} error: HTTP ${response.statusCode}`,
            response.statusCode,
            errorPayload
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });

        if (response.statusCode === 204) {
          return {
            statusCode: response.statusCode,
            payload: undefined as T,
          } satisfies ServiceRequestResult<T>;
        }

        const payload = (await response.body.json()) as T;
        return {
          statusCode: response.statusCode,
          payload,
        } satisfies ServiceRequestResult<T>;
      }
    );
  } catch (error) {
    if (error instanceof ServiceRequestError) {
      span.recordException(error);
    } else if (error instanceof Error) {
      span.recordException(error);
    }
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message:
        error instanceof Error ? error.message : "Service request failed",
    });
    throw error;
  } finally {
    span.end();
  }
}
