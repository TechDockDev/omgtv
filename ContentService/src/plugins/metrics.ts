import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { recordHttpRequest } from "../observability/metrics";

const REQUEST_START = Symbol("content.metrics.requestStart");

type RequestWithStart = {
  [REQUEST_START]?: bigint;
};

function normalizeRoute(route?: string) {
  if (!route) {
    return "unmatched";
  }
  if (route.startsWith("/api/v1/content")) {
    return route.replace("/api/v1/content", "");
  }
  return route;
}

export default fp(async function metricsPlugin(fastify: FastifyInstance) {
  fastify.addHook("onRequest", (request, _reply, done) => {
    (request as unknown as RequestWithStart)[REQUEST_START] =
      process.hrtime.bigint();
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    const start = (request as unknown as RequestWithStart)[REQUEST_START];
    if (typeof start === "bigint") {
      const diffNs = process.hrtime.bigint() - start;
      const durationMs = Number(diffNs) / 1_000_000;
      const routeConfig = request.routeConfig as {
        metricsId?: string;
      };
      const routeId =
        (typeof routeConfig?.metricsId === "string"
          ? routeConfig.metricsId
          : undefined) ??
        request.routerPath ??
        request.routeOptions.url ??
        request.url;
      const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
      recordHttpRequest(durationMs, {
        method: request.method,
        route: normalizeRoute(routeId),
        statusClass,
        source: "fastify",
      });
    }
    done();
  });
});
