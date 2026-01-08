import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  searchQuerySchema,
  searchSuccessResponseSchema,
  type SearchQuery,
  type SearchResponse,
} from "../schemas/search.schema";
import { errorResponseSchema } from "../schemas/base.schema";
import { searchCatalog } from "../proxy/search.proxy";

export default fp(
  async function searchRoutes(fastify: FastifyInstance) {
    fastify.route<{
      Querystring: SearchQuery;
      Reply: SearchResponse;
    }>({
      method: "GET",
      url: "/",
      schema: {
        querystring: searchQuerySchema,
        response: {
          200: searchSuccessResponseSchema,
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: {
        auth: { public: true },
        rateLimitPolicy: "anonymous",
      },
      async handler(request) {
        const query = searchQuerySchema.parse(request.query);
        const results = await searchCatalog(
          query,
          request.correlationId,
          request.user,
          request.telemetrySpan
        );
        request.log.info({ query: query.q }, "Search forwarded to catalog");
        return results;
      },
    });
  },
  { name: "search-routes" }
);
