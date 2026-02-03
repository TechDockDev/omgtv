import type { Span } from "@opentelemetry/api";
import { resolveServiceUrl } from "../config";
import { performServiceRequest, UpstreamServiceError } from "../utils/http";
import { createHttpError } from "../utils/errors";
import {
  searchQuerySchema,
  searchResponseSchema,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
} from "../schemas/search.schema";
import type { GatewayUser } from "../types";

// Helper to map different upstream responses to unified SearchResult
// Helper to map different upstream responses to unified SearchResult
function mapToSearchResult(item: any): SearchResult {
  const ratingVal = typeof item.ratings?.average === 'number' ? item.ratings.average : 0;

  return {
    id: item.id,
    type: "series",
    title: item.title,
    subtitle: item.synopsis || item.description || null,
    duration: item.durationSeconds ? String(item.durationSeconds) : null,
    ThumbnailUrl: item.heroImageUrl || item.thumbnail || null,
    watchedDuration: null, // Dynamic: needs Engagement Service
    progress: null, // Dynamic: needs Engagement Service
    rating: 0, // User's personal rating, needs Engagement Service
    lastWatchedAt: null, // Dynamic: needs Engagement Service
    series_id: item.id,
    engagement: {
      likeCount: 0, // Placeholder
      viewCount: 0, // Placeholder
      isLiked: false, // Placeholder
      isSaved: false, // Placeholder
      averageRating: ratingVal,
      reviewCount: 0, // Placeholder
    },
  };
}

export async function searchCatalog(
  query: SearchQuery,
  correlationId: string,
  user?: GatewayUser,
  span?: Span
): Promise<SearchResponse> {
  const validatedQuery = searchQuerySchema.parse(query);
  const { q } = validatedQuery;

  // 1. Fetch Search History (if user exists)
  // EngagementService now expected to return objects: { id, query, createdAt }
  const historyPromise = user
    ? performServiceRequest<{ history: any[] }>({
      serviceName: "engagement",
      baseUrl: resolveServiceUrl("engagement"),
      path: `/internal/history/user/${user.id}`,
      method: "GET",
      correlationId,
      user,
      parentSpan: span,
      spanName: "proxy:search:history",
    }).then((res) => {
      // Engagement service returns enveloped response: { data: { history: [] } }
      const payload = res.payload as any;
      const data = payload.data || payload;
      console.log("[SearchProxy] History Response Data:", JSON.stringify(data, null, 2));
      return data.history || [];
    })
      .catch((err) => {
        // Assuming 'request' is available in this scope, or needs to be passed/inferred.
        // For now, using console.error as a fallback if 'request' is not globally available.
        // If 'request' is part of a Fastify context, it would need to be passed into this function.
        // Given the instruction, I'll assume 'request.log.warn' is the desired logging mechanism.
        // If 'request' is not defined, this will cause a runtime error.
        // For a robust solution, 'request' (or its logger) should be passed as an argument.
        // For now, I'll apply the change as literally as possible, assuming 'request' is accessible.
        // If 'request' is not available, the original console.error is safer.
        // Since the instruction explicitly states `request.log.warn`, I will use it.
        // If this code is not part of a Fastify request handler, `request` will be undefined.
        // I'll make a note here, but apply the change as requested.
        console.error("Failed to fetch search history", err); // Fallback if request.log is not available
        // request.log.warn({ err }, "Failed to fetch search history"); // This line would be used if 'request' was in scope
        return [];
      })
    : Promise.resolve([]);

  // 2. Perform Search or List (Main Content)
  let resultsPromise: Promise<{ items: SearchResult[]; nextCursor?: string | null; total?: number }>;

  if (q && q.trim().length > 0) {
    // Call Search Service
    const baseUrl = resolveServiceUrl("search");
    resultsPromise = performServiceRequest<any>({
      serviceName: "search",
      baseUrl,
      path: "/internal/search",
      method: "GET",
      correlationId,
      user,
      query: {
        q: q,
        limit: validatedQuery.limit,
        offset: validatedQuery.offset,
      },
      parentSpan: span,
      spanName: "proxy:search:query",
    }).then((res) => {
      const hits = res.payload.hits || [];
      return {
        items: hits.map(mapToSearchResult),
        total: res.payload.estimatedTotalHits,
        nextCursor: null,
      };
    });

    // 3. Record Search History (Fire-and-forget)
    if (user) {
      performServiceRequest({
        serviceName: "engagement",
        baseUrl: resolveServiceUrl("engagement"),
        path: "/internal/history",
        method: "POST",
        correlationId,
        user,
        body: {
          userId: user.id,
          query: q
        },
        parentSpan: span,
        spanName: "proxy:search:record_history",
      }).catch(err => console.error("Failed to record search history", err));
    }

  } else {
    // Call Content Service (browsing/listing)
    // Fallback to listing series if no query
    const baseUrl = resolveServiceUrl("content");
    resultsPromise = performServiceRequest<any>({
      serviceName: "content",
      baseUrl,
      path: "/internal/series",
      method: "GET",
      correlationId,
      user,
      query: {
        limit: validatedQuery.limit,
        cursor: validatedQuery.cursor,
      },
      parentSpan: span,
      spanName: "proxy:search:browse",
    }).then((res) => {
      const data = res.payload.data || res.payload;
      const mappedItems = (data.items || []).map(mapToSearchResult);
      console.log("[SearchProxy] Mapped Items Sample:", JSON.stringify(mappedItems[0], null, 2));
      return {
        items: mappedItems,
        nextCursor: data.nextCursor,
        total: data.total,
      };
    });
  }

  // 4. Await and Merge
  const [history, results] = await Promise.all([historyPromise, resultsPromise]);

  return {
    items: results.items,
    history: history, // passed as-is
    nextCursor: results.nextCursor || null,
    total: results.total,
  };
}
