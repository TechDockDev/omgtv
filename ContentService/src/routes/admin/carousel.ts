import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CatalogService,
  CatalogServiceError,
} from "../../services/catalog-service";
import { loadConfig } from "../../config";
import { type CarouselEntryWithContent } from "../../repositories/catalog-repository";

const carouselItemInputSchema = z
  .object({
    seriesId: z.string().uuid().optional(),
    episodeId: z.string().uuid().optional(),
  })
  .refine((value) => {
    const hasSeries = Boolean(value.seriesId);
    const hasEpisode = Boolean(value.episodeId);
    return hasSeries !== hasEpisode;
  }, "Provide either seriesId or episodeId (but not both)");

const setCarouselSchema = z.object({
  items: z
    .array(carouselItemInputSchema)
    .min(1, "At least one carousel entry is required")
    .max(50, "Carousel is limited to 50 entries"),
});

type SetCarouselInput = z.infer<typeof setCarouselSchema>;

type CarouselResponseItem = {
  id: string;
  position: number;
  type: "episode" | "series";
  series: null | {
    id: string;
    slug: string;
    title: string;
    synopsis: string | null;
    heroImageUrl: string | null;
    bannerImageUrl: string | null;
    category: string | null;
  };
  episode: null | {
    id: string;
    slug: string;
    title: string;
    seriesId: string;
    seriesTitle: string;
    durationSeconds: number;
    manifestUrl: string | null;
    thumbnailUrl: string | null;
    publishedAt: string | null;
  };
};

function formatCarouselEntry(
  entry: CarouselEntryWithContent
): CarouselResponseItem {
  const type = entry.episodeId ? "episode" : "series";
  const seriesPayload = entry.series
    ? {
      id: entry.series.id,
      slug: entry.series.slug,
      title: entry.series.title,
      synopsis: entry.series.synopsis ?? null,
      heroImageUrl: entry.series.heroImageUrl ?? null,
      bannerImageUrl: entry.series.bannerImageUrl ?? null,
      category: entry.series.category?.name ?? null,
    }
    : null;

  const episodePayload = entry.episode
    ? {
      id: entry.episode.id,
      slug: entry.episode.slug,
      title: entry.episode.title,
      seriesId: entry.episode.seriesId,
      seriesTitle: entry.episode.series.title,
      durationSeconds: entry.episode.durationSeconds,
      manifestUrl: entry.episode.mediaAsset?.manifestUrl ?? null,
      thumbnailUrl:
        entry.episode.defaultThumbnailUrl ??
        entry.episode.mediaAsset?.defaultThumbnailUrl ??
        entry.episode.series.heroImageUrl ??
        null,
      publishedAt: entry.episode.publishedAt
        ? entry.episode.publishedAt.toISOString()
        : null,
    }
    : null;

  return {
    id: entry.id,
    position: entry.position,
    type,
    series: seriesPayload,
    episode: episodePayload,
  } satisfies CarouselResponseItem;
}

function requireAdminId(request: FastifyRequest, reply: FastifyReply) {
  const value = request.headers["x-admin-id"];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
}

export default async function adminCarouselRoutes(fastify: FastifyInstance) {
  const config = loadConfig();
  const catalog = new CatalogService({
    defaultOwnerId: config.DEFAULT_OWNER_ID,
  });

  fastify.get("/", {
    handler: async (request, reply) => {
      try {
        const entries = await catalog.getCarouselEntries();
        return reply.send({
          items: entries.map((entry) => formatCarouselEntry(entry)),
        });
      } catch (error) {
        request.log.error({ err: error }, "Failed to get carousel entries");
        return reply.status(500).send({ message: "Unable to get carousel" });
      }
    },
  });

  fastify.post<{ Body: SetCarouselInput }>("/", {
    schema: {
      body: setCarouselSchema,
    },
    handler: async (request, reply) => {
      const body = setCarouselSchema.parse(request.body);
      const adminId = requireAdminId(request, reply);
      try {
        const entries = await catalog.setCarouselEntries(adminId, body);
        return reply.status(200).send({
          items: entries.map((entry) => formatCarouselEntry(entry)),
        });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to set carousel entries");
        return reply.status(500).send({ message: "Unable to set carousel" });
      }
    },
  });

  fastify.post<{ Body: SetCarouselInput }>("/reorder", {
    schema: {
      body: setCarouselSchema,
    },
    handler: async (request, reply) => {
      const body = setCarouselSchema.parse(request.body);
      const adminId = requireAdminId(request, reply);
      try {
        const entries = await catalog.setCarouselEntries(adminId, body);
        return reply.status(200).send({
          items: entries.map((entry) => formatCarouselEntry(entry)),
        });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to reorder carousel entries");
        return reply.status(500).send({ message: "Unable to reorder carousel" });
      }
    },
  });

  fastify.post<{ Params: { seriesId: string } }>("/series/:seriesId", {
    schema: {
      params: z.object({ seriesId: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { seriesId } = request.params;
      const adminId = requireAdminId(request, reply);
      try {
        await catalog.addCarouselSeries(adminId, seriesId);
        // Requirement implies we might want the full list, but standard REST usually returns the created resource.
        // However, user said "on successpost get carousel api also get updated carousel api" for rearrange.
        // For add, it's ambiguous. But to be safe and consistent with "state of carousel", maybe returning list is better?
        // But getCarouselEntries is a separate call. The client can call it.
        // I'll return the updated list for convenience if possible, but addCarouselSeries returns single entry.
        // I will return success and let client fetch if needed, similar to REST.
        // Actually, let's just return { success: true } or the entry.
        return reply.status(200).send({ success: true, message: "Series added to carousel" });
      } catch (error) {
        if (error instanceof CatalogServiceError) {
          if (error.code === "FAILED_PRECONDITION") {
            return reply.status(412).send({ message: error.message });
          }
          if (error.code === "NOT_FOUND") {
            return reply.status(404).send({ message: error.message });
          }
        }
        request.log.error({ err: error }, "Failed to add series to carousel");
        return reply.status(500).send({ message: "Unable to add series to carousel" });
      }
    },
  });

  fastify.delete<{ Params: { seriesId: string } }>("/series/:seriesId", {
    schema: {
      params: z.object({ seriesId: z.string().uuid() }),
    },
    handler: async (request, reply) => {
      const { seriesId } = request.params;
      const adminId = requireAdminId(request, reply);
      try {
        await catalog.removeCarouselSeries(adminId, seriesId);
        return reply.status(200).send({ success: true, message: "Series removed from carousel" });
      } catch (error) {
        request.log.error({ err: error }, "Failed to remove series from carousel");
        return reply.status(500).send({ message: "Unable to remove series from carousel" });
      }
    },
  });
}
