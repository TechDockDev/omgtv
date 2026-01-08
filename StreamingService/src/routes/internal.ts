import { randomBytes } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  playbackParamsSchema,
  playbackQuerySchema,
  type PlaybackResponse,
} from "../schemas/streaming";
import { loadConfig } from "../config";

function buildPlaybackUrl(
  id: string,
  cdnBaseUrl: string,
  ttlSeconds: number,
  query: { quality?: string; device?: string }
): PlaybackResponse {
  const url = new URL(`/videos/${id}/master.m3u8`, cdnBaseUrl);
  if (query.quality) {
    url.searchParams.set("quality", query.quality);
  }
  if (query.device) {
    url.searchParams.set("device", query.device);
  }
  url.searchParams.set("token", randomBytes(12).toString("hex"));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return {
    playbackUrl: url.toString(),
    expiresAt,
    cdn: new URL(cdnBaseUrl).host,
  };
}

export default fp(async function internalRoutes(fastify: FastifyInstance) {
  const config = loadConfig();

  fastify.get("/playback/:id", {
    schema: {
      params: playbackParamsSchema,
      querystring: playbackQuerySchema,
    },
    handler: async (request) => {
      const params = playbackParamsSchema.parse(request.params);
      const query = playbackQuerySchema.parse(request.query ?? {});
      const response = buildPlaybackUrl(
        params.id,
        config.CDN_BASE_URL,
        config.SIGNED_URL_TTL_SECONDS,
        {
          quality: query.quality,
          device: query.device,
        }
      );
      request.log.debug(
        { videoId: params.id, quality: query.quality, device: query.device },
        "Generated streaming URL"
      );
      return response;
    },
  });
});
