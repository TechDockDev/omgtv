import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  searchQuerySchema,
  type SearchQuery,
  type SearchResponse,
} from "../schemas/search";
import { loadConfig } from "../config";

type CatalogEntry = {
  id: string;
  title: string;
  snippet: string;
  type: "video" | "channel" | "playlist";
  keywords: string[];
};

const catalog: CatalogEntry[] = [
  {
    id: "video-heroic-pentakill",
    title: "Heroic Pentakill Montage",
    snippet: "Relive the clutch pentakill that closed out Game 5.",
    type: "video",
    keywords: ["pentakill", "montage", "game 5"],
  },
  {
    id: "channel-pocketlol-pros",
    title: "PocketLOL Pros",
    snippet: "Official channel for PocketLOL professional highlights.",
    type: "channel",
    keywords: ["pros", "highlights", "official"],
  },
  {
    id: "video-support-guide",
    title: "Ultimate Support Guide 2025",
    snippet: "Meta breakdown with in-depth warding strategies.",
    type: "video",
    keywords: ["support", "guide", "meta"],
  },
  {
    id: "playlist-season-recaps",
    title: "Season Recap Playlist",
    snippet: "Catch up on every key series in 30 minutes or less.",
    type: "playlist",
    keywords: ["recap", "season", "series"],
  },
];

function filterCatalog(query: SearchQuery): CatalogEntry[] {
  const normalized = query.q.toLowerCase();
  return catalog.filter((entry) => {
    return (
      entry.title.toLowerCase().includes(normalized) ||
      entry.snippet.toLowerCase().includes(normalized) ||
      entry.keywords.some((keyword) => keyword.includes(normalized))
    );
  });
}

function paginate(
  results: CatalogEntry[],
  start: number,
  size: number
): {
  items: CatalogEntry[];
  nextCursor?: string;
} {
  const slice = results.slice(start, start + size);
  const nextCursor =
    start + size < results.length ? String(start + size) : undefined;
  return { items: slice, nextCursor };
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function serialize(entries: CatalogEntry[]): SearchResponse["items"] {
  return entries.map(({ id, title, snippet, type }) => ({
    id,
    title,
    snippet,
    type,
  }));
}

export default fp(async function internalRoutes(fastify: FastifyInstance) {
  const config = loadConfig();

  fastify.get("/search", {
    schema: {
      querystring: searchQuerySchema,
    },
    handler: async (request) => {
      const query = searchQuerySchema.parse(request.query);
      const limit = query.limit ?? config.DEFAULT_PAGE_SIZE;
      const start = parseCursor(query.cursor);
      const matches = filterCatalog(query);
      const { items, nextCursor } = paginate(matches, start, limit);
      request.log.debug(
        { query: query.q, matches: matches.length, returned: items.length },
        "Processed search query"
      );
      return {
        items: serialize(items),
        nextCursor,
      } satisfies SearchResponse;
    },
  });
});
