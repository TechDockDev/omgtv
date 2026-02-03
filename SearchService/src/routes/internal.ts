import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getClient, SERIES_INDEX } from "../lib/meilisearch";

// Schemas
const searchSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const syncSchema = z.object({
  action: z.enum(["upsert", "delete"]),
  payload: z.object({
    id: z.string(),
  }).passthrough(),
});

export default async function internalRoutes(fastify: FastifyInstance) {
  const meili = getClient();
  const index = meili.index(SERIES_INDEX);

  // Health check for Meilisearch connection specifically
  fastify.get("/health", async () => {
    try {
      await meili.health();
      return { status: "ok", meilisearch: "connected" };
    } catch (err) {
      return { status: "error", meilisearch: "disconnected", error: String(err) };
    }
  });

  // Search Endpoint
  fastify.get("/search", {
    schema: {
      querystring: searchSchema,
    },
    handler: async (request) => {
      const { q, limit, offset } = searchSchema.parse(request.query);

      // Cap limit at 50 as safe guard
      const safeLimit = Math.min(limit, 50);

      const result = await index.search(q, {
        limit: safeLimit,
        offset,
        attributesToRetrieve: ["*"], // Return full object as stored
        showMatchesPosition: true,
      });

      return {
        hits: result.hits,
        estimatedTotalHits: result.estimatedTotalHits,
        processingTimeMs: result.processingTimeMs,
        query: result.query,
      };
    },
  });

  // Sync Endpoint (Upsert / Delete)
  fastify.post("/sync", {
    schema: {
      body: syncSchema,
    },
    handler: async (request) => {
      const { action, payload } = syncSchema.parse(request.body);

      request.log.info({ action, id: payload.id }, "Sync request received");

      if (action === "delete") {
        await index.deleteDocument(payload.id);
        return { success: true, action: "deleted", id: payload.id };
      } else {
        // Upsert
        // We expect payload to be a complete or partial document. 
        // Meilisearch merge usage: addDocuments works as upsert/merge using primary key.
        await index.addDocuments([payload]);
        return { success: true, action: "upserted", id: payload.id };
      }
    },
  });
}
