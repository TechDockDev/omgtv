import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";
import {
  searchQuerySchema,
  searchResponseSchema,
  type SearchQuery,
  type SearchResponse,
} from "../schemas/search.schema";
import type { GatewayUser } from "../types";

export async function searchCatalog(
  query: SearchQuery,
  correlationId: string,
  user?: GatewayUser,
  span?: Span
): Promise<SearchResponse> {
  const baseUrl = resolveServiceUrl("search");
  const validatedQuery = searchQuerySchema.parse(query);

  let payload: unknown;
  try {
    const response = await performServiceRequest<SearchResponse>({
      serviceName: "search",
      baseUrl,
      path: "/internal/search",
      method: "GET",
      correlationId,
      user,
      query: {
        q: validatedQuery.q,
        limit: validatedQuery.limit,
        cursor: validatedQuery.cursor,
      },
      parentSpan: span,
      spanName: "proxy:search:catalog",
    });
    payload = response.payload;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      throw createHttpError(
        error.statusCode >= 500 ? 502 : error.statusCode,
        "Search service unavailable",
        error.cause
      );
    }
    throw error;
  }

  const parsed = searchResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid response from search service");
  }

  return parsed.data;
}
